import type {
  AccessCheck,
  CapabilityReport,
  K8sApi,
  K8sServerInfo,
  K8sVersion,
  KubeObject,
  ListOptions,
  ManagedBy,
  ResourceRef,
  Watch,
  WatchHandlers,
} from "../k8s.js";
import { RESOURCES } from "../k8s.js";
import { ownerMarkers, product } from "../../product.js";
import { MOCK_NOW } from "./time.js";

export const OWNER_LABEL = "app.kubernetes.io/managed-by";

const refKey = (ref: ResourceRef) => `${ref.group}/${ref.plural}`;

function matchesSelector(obj: KubeObject, selector: string | undefined): boolean {
  if (!selector) return true;
  const labels = obj.metadata.labels ?? {};
  return selector
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean)
    .every((term) => {
      const negated = term.includes("!=");
      const [key = "", value] = term.split(negated ? "!=" : /==?/).map((part) => part.trim());
      if (value === undefined) return key.startsWith("!") ? !(key.slice(1) in labels) : key in labels;
      return negated ? labels[key] !== value : labels[key] === value;
    });
}

export function managedByOf(obj: KubeObject): ManagedBy | null {
  const labels = obj.metadata.labels ?? {};
  const annotations = obj.metadata.annotations ?? {};
  if (annotations["objectset.rio.cattle.io/id"]?.startsWith("fleet") || labels["objectset.rio.cattle.io/hash"]) {
    return "fleet";
  }
  if (annotations["argocd.argoproj.io/tracking-id"] || labels["argocd.argoproj.io/instance"]) return "argo";
  if (labels[OWNER_LABEL] === "Helm") return "helm";
  return null;
}

const sameObject = (a: KubeObject, name: string, namespace?: string) =>
  a.metadata.name === name && (a.metadata.namespace ?? undefined) === (namespace ?? undefined);

const accessKey = (check: AccessCheck) =>
  `${check.verb} ${check.group}/${check.resource}${check.subresource ? `/${check.subresource}` : ""}`;

// The certificate k3s generates for its API server, 300 days from expiry.
export const mockServerInfo: K8sServerInfo = {
  url: "https://10.0.0.10:6443",
  host: "10.0.0.10",
  certificate: {
    subject: "k3s",
    issuer: "k3s-server-ca",
    notAfter: new Date(MOCK_NOW + 300 * 86_400_000).toISOString(),
  },
};

export interface FakeK8sOptions {
  objects?: Array<{ ref: ResourceRef; items: KubeObject[] }>;
  // API groups the fake cluster does not serve, e.g. "velero.io".
  absentGroups?: string[];
  // Responses for raw(path).
  raw?: Record<string, unknown>;
  // Log lines by "namespace/pod".
  logs?: Record<string, string[]>;
  version?: K8sVersion;
  serverInfo?: K8sServerInfo;
  // Access checks to deny, as "verb group/resource[/subresource]".
  denied?: string[];
}

export interface FakeK8s extends K8sApi {
  set(ref: ResourceRef, items: KubeObject[]): void;
  upsert(ref: ResourceRef, obj: KubeObject): void;
  remove(ref: ResourceRef, name: string, namespace?: string): void;
  // Every create() and delete() call, in order.
  writes: Array<{ verb: "create" | "delete"; ref: ResourceRef; name: string; namespace?: string }>;
}

// An in-memory K8sApi for module tests: lists, gets and watches over the
// objects given, "absent" for unserved groups, deterministic everything.
export function createFakeK8s(options: FakeK8sOptions = {}): FakeK8s {
  const store = new Map<string, KubeObject[]>();
  const watchers = new Map<string, Set<{ options: ListOptions; handlers: WatchHandlers<KubeObject> }>>();
  const absent = new Set(options.absentGroups ?? []);
  const denied = new Set(options.denied ?? []);
  for (const { ref, items } of options.objects ?? []) store.set(refKey(ref), [...items]);

  const visible = (ref: ResourceRef, opts: ListOptions = {}) =>
    (store.get(refKey(ref)) ?? []).filter(
      (obj) =>
        (!opts.namespace || !ref.namespaced || obj.metadata.namespace === opts.namespace) &&
        matchesSelector(obj, opts.labelSelector)
    );
  const notify = (ref: ResourceRef, fire: (handlers: WatchHandlers<KubeObject>, opts: ListOptions) => void) => {
    for (const watcher of watchers.get(refKey(ref)) ?? []) fire(watcher.handlers, watcher.options);
  };

  const writes: FakeK8s["writes"] = [];

  const fake: FakeK8s = {
    writes,
    async list<T extends KubeObject>(ref: ResourceRef, opts?: ListOptions) {
      if (absent.has(ref.group)) return "absent" as const;
      return structuredClone(visible(ref, opts)) as T[];
    },
    async get<T extends KubeObject>(ref: ResourceRef, name: string, namespace?: string) {
      if (absent.has(ref.group)) return "absent" as const;
      const found = (store.get(refKey(ref)) ?? []).find((obj) => sameObject(obj, name, namespace));
      return found ? (structuredClone(found) as T) : null;
    },
    async watch<T extends KubeObject>(ref: ResourceRef, opts: ListOptions = {}, handlers: WatchHandlers<T> = {}) {
      if (absent.has(ref.group)) return "absent" as const;
      const key = refKey(ref);
      const entry = { options: opts, handlers: handlers as WatchHandlers<KubeObject> };
      if (!watchers.has(key)) watchers.set(key, new Set());
      watchers.get(key)!.add(entry);
      for (const obj of visible(ref, opts)) handlers.add?.(structuredClone(obj) as T);
      const watch: Watch<T> = {
        synced: Promise.resolve(),
        list: () => structuredClone(visible(ref, opts)) as T[],
        stop: () => {
          watchers.get(key)?.delete(entry);
        },
      };
      return watch;
    },
    async create<T extends KubeObject>(ref: ResourceRef, obj: T) {
      if (absent.has(ref.group))
        throw new Error(`fake k8s: the server could not find the requested resource (${ref.plural})`);
      const { name, namespace } = obj.metadata;
      if (denied.has(`create ${ref.group}/${ref.plural}`))
        throw new Error(`fake k8s: forbidden: cannot create ${ref.plural}`);
      if ((store.get(refKey(ref)) ?? []).some((existing) => sameObject(existing, name, namespace)))
        throw new Error(`fake k8s: ${ref.plural} "${name}" already exists`);
      const created = structuredClone(obj);
      created.metadata.labels = { ...created.metadata.labels, ...fake.ownedLabels() };
      created.metadata.uid ??= `uid-${ref.plural}-${namespace ?? ""}-${name}`;
      writes.push({ verb: "create", ref, name, ...(namespace ? { namespace } : {}) });
      fake.upsert(ref, created);
      return structuredClone(created);
    },
    async delete(ref: ResourceRef, name: string, namespace?: string) {
      if (denied.has(`delete ${ref.group}/${ref.plural}`))
        throw new Error(`fake k8s: forbidden: cannot delete ${ref.plural}`);
      writes.push({ verb: "delete", ref, name, ...(namespace ? { namespace } : {}) });
      fake.remove(ref, name, namespace);
    },
    async raw(path) {
      if (!options.raw || !(path in options.raw)) throw new Error(`fake k8s: no raw response for ${path}`);
      return structuredClone(options.raw[path]);
    },
    async logs(namespace, pod, logOptions, onLine) {
      const lines = options.logs?.[`${namespace}/${pod}`];
      if (!lines) throw new Error(`fake k8s: pods "${pod}" not found in ${namespace}`);
      const tail = logOptions.tailLines ? lines.slice(-logOptions.tailLines) : lines;
      for (const line of tail) onLine(line);
      return { done: Promise.resolve(), stop() {} };
    },
    async serverInfo() {
      return options.serverInfo ?? mockServerInfo;
    },
    async version() {
      return options.version ?? { major: "1", minor: "31", gitVersion: "v1.31.4+k3s1", platform: "linux/amd64" };
    },
    async capabilities() {
      const report: CapabilityReport = {
        checkedAt: new Date(MOCK_NOW).toISOString(),
        capabilities: Object.entries(RESOURCES).map(([id, ref]) => {
          const check: AccessCheck = { verb: "list", group: ref.group, resource: ref.plural };
          const groupPresent = !absent.has(ref.group);
          const allowed = groupPresent && !denied.has(accessKey(check));
          return {
            id,
            label: ref.kind,
            check,
            allowed,
            groupPresent,
            ...(id === "secrets" ? { optIn: true } : {}),
            ...(allowed ? {} : { needs: groupPresent ? `list on ${ref.plural}` : `${ref.group} installed` }),
          };
        }),
      };
      return report;
    },
    async can(check) {
      return !absent.has(check.group) && !denied.has(accessKey(check));
    },
    managedBy: managedByOf,
    ownedLabels: () => ({ [OWNER_LABEL]: product.ownerMarker.labelDomain }),
    isOwned: (obj) => ownerMarkers.some((marker) => obj.metadata.labels?.[OWNER_LABEL] === marker.labelDomain),
    set(ref, items) {
      store.set(refKey(ref), [...items]);
    },
    upsert(ref, obj) {
      const items = store.get(refKey(ref)) ?? [];
      const index = items.findIndex((existing) => sameObject(existing, obj.metadata.name, obj.metadata.namespace));
      const old = index >= 0 ? items[index] : undefined;
      if (index >= 0) items[index] = obj;
      else items.push(obj);
      store.set(refKey(ref), items);
      notify(ref, (handlers, opts) => {
        if (!matchesSelector(obj, opts.labelSelector)) return;
        if (opts.namespace && obj.metadata.namespace !== opts.namespace) return;
        if (old) handlers.update?.(structuredClone(obj), structuredClone(old));
        else handlers.add?.(structuredClone(obj));
      });
    },
    remove(ref, name, namespace) {
      const items = store.get(refKey(ref)) ?? [];
      const gone = items.find((obj) => sameObject(obj, name, namespace));
      if (!gone) return;
      store.set(
        refKey(ref),
        items.filter((obj) => obj !== gone)
      );
      notify(ref, (handlers) => handlers.delete?.(structuredClone(gone)));
    },
  };
  return fake;
}

// A small, consistent cluster: three nodes (one NotReady), pods including a
// crashlooper, the PVCs the backup mocks refer to.
export function mockClusterObjects(): Array<{ ref: ResourceRef; items: KubeObject[] }> {
  const at = new Date(MOCK_NOW - 30 * 86_400_000).toISOString();
  const node = (name: string, ready: boolean): KubeObject => ({
    apiVersion: "v1",
    kind: "Node",
    metadata: { name, uid: `node-${name}`, creationTimestamp: at, labels: { "kubernetes.io/hostname": name } },
    status: {
      conditions: [
        { type: "Ready", status: ready ? "True" : "False", reason: ready ? "KubeletReady" : "NodeStatusUnknown" },
      ],
      nodeInfo: { kubeletVersion: "v1.31.4+k3s1" },
    },
  });
  const pvc = (namespace: string, name: string, uid: string): KubeObject => ({
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name, namespace, uid, creationTimestamp: at },
    spec: { storageClassName: "longhorn", resources: { requests: { storage: "10Gi" } } },
    status: { phase: "Bound", capacity: { storage: "10Gi" } },
  });
  return [
    { ref: RESOURCES.nodes, items: [node("node-1", true), node("node-2", true), node("node-3", false)] },
    {
      ref: RESOURCES.namespaces,
      items: ["apps", "gitea", "monitoring", "media"].map((name) => ({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name, creationTimestamp: at },
        status: { phase: "Active" },
      })),
    },
    {
      ref: RESOURCES.pods,
      items: [
        {
          apiVersion: "v1",
          kind: "Pod",
          metadata: { name: "jellyfin-7c9d8", namespace: "media", uid: "pod-jellyfin", creationTimestamp: at },
          spec: { nodeName: "node-2", containers: [{ name: "jellyfin", image: "jellyfin/jellyfin:10.9" }] },
          status: {
            phase: "Running",
            containerStatuses: [
              {
                name: "jellyfin",
                ready: false,
                restartCount: 14,
                image: "jellyfin/jellyfin:10.9",
                state: { waiting: { reason: "CrashLoopBackOff" } },
              },
            ],
          },
        },
        {
          apiVersion: "v1",
          kind: "Pod",
          metadata: { name: "grafana-5f7b9", namespace: "monitoring", uid: "pod-grafana", creationTimestamp: at },
          spec: { nodeName: "node-1", containers: [{ name: "grafana", image: "grafana/grafana:11.2.0" }] },
          status: {
            phase: "Running",
            containerStatuses: [
              {
                name: "grafana",
                ready: true,
                restartCount: 0,
                image: "grafana/grafana:11.2.0",
                state: { running: {} },
              },
            ],
          },
        },
      ],
    },
    {
      ref: RESOURCES.pvcs,
      items: [
        pvc("apps", "postgres-data", "11111111-0000-4000-8000-000000000001"),
        pvc("gitea", "gitea-shared-storage", "11111111-0000-4000-8000-000000000002"),
        pvc("monitoring", "grafana", "11111111-0000-4000-8000-000000000003"),
        pvc("media", "jellyfin-config", "11111111-0000-4000-8000-000000000004"),
        pvc("apps", "scratch-cache", "11111111-0000-4000-8000-000000000005"),
      ],
    },
  ];
}

const condition = (type: string, ok: boolean) => ({ type, status: ok ? "True" : "False" });

// Longhorn's own view of the same cluster, in longhorn-system: node-3's disk
// is down with it, so the postgres volume runs degraded on one healthy and
// one failed replica; the jellyfin volume has a user snapshot and a system one.
export function mockLonghornObjects(): Array<{ ref: ResourceRef; items: KubeObject[] }> {
  const ns = "longhorn-system";
  const at = new Date(MOCK_NOW - 30 * 86_400_000).toISOString();
  const node = (name: string, ready: boolean, availableGi: number): KubeObject => ({
    apiVersion: "longhorn.io/v1beta2",
    kind: "Node",
    metadata: { name, namespace: ns, creationTimestamp: at },
    spec: {
      allowScheduling: true,
      disks: { "default-disk": { path: "/var/lib/longhorn/", allowScheduling: true, storageReserved: 0 } },
    },
    status: {
      conditions: [condition("Ready", ready), condition("Schedulable", ready)],
      diskStatus: {
        "default-disk": {
          diskUUID: `disk-${name}`,
          storageMaximum: 100 * 2 ** 30,
          storageAvailable: availableGi * 2 ** 30,
          storageScheduled: 30 * 2 ** 30,
          conditions: [condition("Ready", ready), condition("Schedulable", ready)],
        },
      },
    },
  });
  const pg = "pvc-11111111-0000-4000-8000-000000000001";
  const jf = "pvc-11111111-0000-4000-8000-000000000004";
  const replica = (volume: string, nodeID: string, state: string, failedAt = ""): KubeObject => ({
    apiVersion: "longhorn.io/v1beta2",
    kind: "Replica",
    metadata: {
      name: `${volume}-r-${nodeID}`,
      namespace: ns,
      labels: { longhornvolume: volume },
      creationTimestamp: at,
    },
    spec: { volumeName: volume, nodeID, diskID: `disk-${nodeID}`, failedAt },
    status: { currentState: state },
  });
  const snapshot = (volume: string, name: string, userCreated: boolean, hoursAgo: number): KubeObject => ({
    apiVersion: "longhorn.io/v1beta2",
    kind: "Snapshot",
    metadata: { name, namespace: ns, labels: { longhornvolume: volume }, creationTimestamp: at },
    spec: { volume, createSnapshot: userCreated },
    status: {
      creationTime: new Date(MOCK_NOW - hoursAgo * 3_600_000).toISOString(),
      readyToUse: true,
      userCreated,
      markRemoved: false,
      size: String(512 * 2 ** 20),
    },
  });
  return [
    {
      ref: RESOURCES.longhornNodes,
      items: [node("node-1", true, 62), node("node-2", true, 8), node("node-3", false, 0)],
    },
    {
      ref: RESOURCES.longhornReplicas,
      items: [
        replica(pg, "node-1", "running"),
        replica(pg, "node-3", "error", new Date(MOCK_NOW - 2 * 3_600_000).toISOString()),
        replica(jf, "node-1", "running"),
        replica(jf, "node-2", "running"),
      ],
    },
    {
      ref: RESOURCES.longhornSnapshots,
      items: [snapshot(jf, "snap-before-upgrade", true, 26), snapshot(jf, "snap-system-a1b2", false, 3)],
    },
  ];
}

// oxlint-disable unicorn/consistent-function-scoping -- row builders sit beside the rows they build
import { createHash } from "node:crypto";
import { format, resolveConfig } from "prettier";
import { MOCK_NOW } from "../../../src/contracts/mocks/time.js";

// Builds the synthetic fixture set in the layout capture-fixtures.sh writes,
// shaped from the upstream API docs and CRDs. test/fixtures/synthetic/ is
// this function's output, committed so a diff shows what a change did to the
// data; `node --import tsx test/support/k8s/writeSynthetic.ts` regenerates it
// and fixtures.test.ts fails when the two disagree. Everything is relative
// to MOCK_NOW, so it lines up with the contract mocks. Annotations capture
// strips (is-default-class, kubectl last-applied) are absent here too.

type Json = Record<string, any>;
export type FixtureFiles = Record<string, unknown>;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(MOCK_NOW - ms).toISOString();
const ahead = (ms: number) => new Date(MOCK_NOW + ms).toISOString();

// Names the tests refer to. Real captures have none of these.
export const scenarios = {
  nodes: { ready: "cp-1", pressure: "worker-1", notReady: "worker-2" },
  pods: {
    healthy: { namespace: "default", name: "web-7d9f8b6c5d-x2k4q" },
    crashloop: { namespace: "default", name: "report-worker-6c8d7f9b4-m5v2n" },
    pending: { namespace: "default", name: "batch-import-5b7c9d8f6-q9w8e" },
    imagePull: { namespace: "default", name: "legacy-app-84f6d5c7b9-t4r6y" },
    completed: { namespace: "default", name: "nightly-db-dump-29326800-8h2kd" },
  },
  longhorn: {
    healthy: "pvc-3f1c6a52-0b7e-4d0a-9a55-1d2b8c9e7a01",
    degraded: "pvc-9a4d2e17-6c3b-4f85-8e20-5b7a1c0d3e02",
    faulted: "pvc-c71e5b93-2d48-41a6-b3f9-8a6d0e4c2f03",
    detached: "pvc-5e8a0c24-7f19-4b3d-a6c2-3d9e1b7f5a04",
    unprotected: "pvc-b2d9f604-1a85-4c7e-9d31-6e0c8a2b4f05",
  },
  pvcs: {
    protected: { namespace: "databases", name: "data-postgres-0" },
    stale: { namespace: "media", name: "media-library" },
    failing: { namespace: "default", name: "uploads" },
    neverRun: { namespace: "default", name: "scratch" },
    unprotected: { namespace: "default", name: "cache" },
    pending: { namespace: "default", name: "reports-archive" },
  },
  velero: {
    completed: "daily-databases-20261007-020012",
    partial: "daily-media-20261006-020009",
    failed: "daily-default-20261004-020004",
    schedule: "daily-databases",
    restore: "restore-databases-20260930",
    locationAvailable: "default",
    locationUnavailable: "offsite",
  },
  fleet: { ready: "cluster-apps", notReady: "cluster-addons" },
  certificates: { healthy: "web-tls", expiring: "grafana-tls", notReady: "legacy-tls" },
} as const;

const meta = (name: string, namespace: string | undefined, extra: Json = {}, ageMs = 20 * DAY): Json => ({
  name,
  ...(namespace ? { namespace } : {}),
  uid: uid(`${namespace ?? ""}/${name}`),
  resourceVersion: "1",
  creationTimestamp: ago(ageMs),
  ...extra,
});

// Stable uuid-shaped ids derived from the whole seed.
function uid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const list = (apiVersion: string, items: Json[]): Json => ({
  apiVersion,
  kind: "List",
  metadata: { resourceVersion: "" },
  items,
});
// The uid also covers the kind: a Longhorn Volume and its BackupVolume share a name.
const item = (apiVersion: string, kind: string, o: Json): Json => ({
  apiVersion,
  kind,
  ...o,
  metadata: { ...o.metadata, uid: uid(`${kind}/${o.metadata.namespace ?? ""}/${o.metadata.name}`) },
});
const NS = [
  "default",
  "kube-system",
  "longhorn-system",
  "velero",
  "fleet-default",
  "cattle-fleet-system",
  "cert-manager",
  "media",
  "databases",
];

const gi = (n: number) => String(n * 1024 ** 3);

function nodes(): Json[] {
  const node = (name: string, role: string | null, ip: string, conds: Record<string, [string, string?]>): Json =>
    item("v1", "Node", {
      metadata: meta(
        name,
        undefined,
        {
          labels: {
            "kubernetes.io/hostname": name,
            "kubernetes.io/os": "linux",
            "kubernetes.io/arch": "amd64",
            ...(role ? { [`node-role.kubernetes.io/${role}`]: "true" } : { "node-role.kubernetes.io/worker": "true" }),
          },
        },
        60 * DAY
      ),
      spec: { podCIDR: "10.42.0.0/24", providerID: `k3s://${name}` },
      status: {
        addresses: [
          { type: "InternalIP", address: ip },
          { type: "Hostname", address: name },
        ],
        allocatable: { cpu: "4", "ephemeral-storage": "98831908074", memory: "16263064Ki", pods: "110" },
        capacity: { cpu: "4", "ephemeral-storage": "101590516Ki", memory: "16263064Ki", pods: "110" },
        conditions: ["MemoryPressure", "DiskPressure", "PIDPressure", "Ready"].map((type) => {
          const [state, reason] = conds[type] ?? [type === "Ready" ? "True" : "False"];
          const unknown = state === "Unknown";
          return {
            type,
            status: state,
            lastHeartbeatTime: unknown ? ago(22 * MIN) : ago(MIN),
            lastTransitionTime: ago(unknown || (state === "True" && type !== "Ready") ? 22 * MIN : 20 * DAY),
            reason:
              reason ??
              (type === "Ready"
                ? "KubeletReady"
                : `Kubelet${type === "MemoryPressure" ? "HasSufficientMemory" : type === "DiskPressure" ? "HasNoDiskPressure" : "HasSufficientPID"}`),
            message: unknown ? "Kubelet stopped posting node status." : "kubelet is posting ready status",
          };
        }),
        daemonEndpoints: { kubeletEndpoint: { Port: 10250 } },
        nodeInfo: {
          architecture: "amd64",
          containerRuntimeVersion: "containerd://1.7.23-k3s2",
          kernelVersion: "6.8.0-48-generic",
          kubeProxyVersion: "v1.31.4+k3s1",
          kubeletVersion: "v1.31.4+k3s1",
          machineID: uid(`machine-${name}`).replaceAll("-", ""),
          operatingSystem: "linux",
          osImage: "Ubuntu 24.04.1 LTS",
          systemUUID: uid(`system-${name}`),
        },
      },
    });
  return [
    node("cp-1", "control-plane", "192.168.10.11", {}),
    node("worker-1", null, "192.168.10.12", { MemoryPressure: ["True", "KubeletHasInsufficientMemory"] }),
    node("worker-2", null, "192.168.10.13", {
      MemoryPressure: ["Unknown", "NodeStatusUnknown"],
      DiskPressure: ["Unknown", "NodeStatusUnknown"],
      PIDPressure: ["Unknown", "NodeStatusUnknown"],
      Ready: ["Unknown", "NodeStatusUnknown"],
    }),
  ];
}

interface PodSpec {
  ns: string;
  name: string;
  node?: string;
  phase?: string;
  owner?: [string, string];
  labels?: Json;
  containers?: string[];
  state?: Json;
  last?: Json;
  restarts?: number;
  ready?: boolean;
  pvc?: string;
  conditions?: Json[];
  ageMs?: number;
  image?: string;
}

function pod(p: PodSpec): Json {
  const phase = p.phase ?? "Running";
  const ready = p.ready ?? phase === "Running";
  const containers = p.containers ?? [p.name.split("-")[0]!];
  const image = p.image ?? "registry.example.lan/apps/app:1.4.2";
  return item("v1", "Pod", {
    metadata: meta(
      p.name,
      p.ns,
      {
        labels: { app: p.name.split("-")[0], ...p.labels },
        ...(p.owner
          ? {
              ownerReferences: [
                {
                  apiVersion: p.owner[0] === "Job" ? "batch/v1" : "apps/v1",
                  kind: p.owner[0],
                  name: p.owner[1],
                  uid: uid(`${p.owner[0]}/${p.ns}/${p.owner[1]}`),
                  controller: true,
                  blockOwnerDeletion: true,
                },
              ],
            }
          : {}),
      },
      p.ageMs ?? 5 * DAY
    ),
    spec: {
      nodeName: p.node,
      restartPolicy: phase === "Succeeded" ? "OnFailure" : "Always",
      serviceAccountName: "default",
      containers: containers.map((name) => ({
        name,
        image,
        command: ["REDACTED"],
        args: ["REDACTED"],
        env: [
          { name: "DATABASE_URL", value: "REDACTED" },
          { name: "LOG_LEVEL", value: "REDACTED" },
        ],
        resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { memory: "512Mi" } },
      })),
      ...(p.pvc ? { volumes: [{ name: "data", persistentVolumeClaim: { claimName: p.pvc } }] } : {}),
    },
    status: {
      phase,
      conditions: p.conditions ?? [
        { type: "Initialized", status: "True", lastTransitionTime: ago(5 * DAY) },
        { type: "Ready", status: ready ? "True" : "False", lastTransitionTime: ago(5 * DAY) },
        { type: "ContainersReady", status: ready ? "True" : "False", lastTransitionTime: ago(5 * DAY) },
        { type: "PodScheduled", status: "True", lastTransitionTime: ago(5 * DAY) },
      ],
      ...(p.node
        ? {
            hostIP: nodeIp(p.node),
            podIP: `10.42.${p.node.endsWith("1") ? 1 : 2}.${(uid(p.name).charCodeAt(0) % 200) + 10}`,
          }
        : {}),
      startTime: ago(p.ageMs ?? 5 * DAY),
      containerStatuses: p.node
        ? containers.map((name) => ({
            name,
            image,
            imageID: `registry.example.lan/apps/app@sha256:${uid(p.name + name)
              .replaceAll("-", "")
              .repeat(2)}`,
            ready,
            started: ready,
            restartCount: p.restarts ?? 0,
            state: p.state ?? { running: { startedAt: ago(5 * DAY) } },
            ...(p.last ? { lastState: p.last } : {}),
          }))
        : undefined,
    },
  });
}

const nodeIp = (node: string) => `192.168.10.${node === "cp-1" ? 11 : node === "worker-1" ? 12 : 13}`;

function pods(): Json[] {
  const s = scenarios.pods;
  const longhornPods = ["cp-1", "worker-1", "worker-2"].map((node, i) =>
    pod({
      ns: "longhorn-system",
      name: `longhorn-manager-${["4qk7d", "9vx2m", "h6tz8"][i]}`,
      node,
      owner: ["DaemonSet", "longhorn-manager"],
      // worker-2 is down: its manager shows Running but not Ready, as the kubelet last reported it.
      ready: node !== "worker-2",
    })
  );
  return [
    pod({
      ns: s.healthy.namespace,
      name: s.healthy.name,
      node: "worker-1",
      owner: ["ReplicaSet", "web-7d9f8b6c5d"],
      labels: { "pod-template-hash": "7d9f8b6c5d" },
    }),
    pod({
      ns: "default",
      name: "web-7d9f8b6c5d-p8l3z",
      node: "cp-1",
      owner: ["ReplicaSet", "web-7d9f8b6c5d"],
      labels: { "pod-template-hash": "7d9f8b6c5d" },
    }),
    pod({
      ns: s.crashloop.namespace,
      name: s.crashloop.name,
      node: "worker-1",
      owner: ["ReplicaSet", "report-worker-6c8d7f9b4"],
      ready: false,
      restarts: 27,
      state: {
        waiting: {
          reason: "CrashLoopBackOff",
          message:
            "back-off 5m0s restarting failed container=report-worker pod=report-worker-6c8d7f9b4-m5v2n_default(2e0f)",
        },
      },
      last: {
        terminated: {
          exitCode: 1,
          reason: "Error",
          startedAt: ago(9 * MIN),
          finishedAt: ago(9 * MIN - 4000),
          containerID: "containerd://6f1d",
        },
      },
    }),
    pod({
      ns: s.pending.namespace,
      name: s.pending.name,
      phase: "Pending",
      owner: ["ReplicaSet", "batch-import-5b7c9d8f6"],
      ageMs: 47 * MIN,
      conditions: [
        {
          type: "PodScheduled",
          status: "False",
          reason: "Unschedulable",
          message:
            "0/3 nodes are available: 1 node(s) had untolerated taint {node.kubernetes.io/unreachable: }, 2 Insufficient memory. preemption: 0/3 nodes are available: 3 No preemption victims found for incoming pod.",
          lastTransitionTime: ago(47 * MIN),
        },
      ],
    }),
    pod({
      ns: s.imagePull.namespace,
      name: s.imagePull.name,
      node: "worker-1",
      phase: "Pending",
      ready: false,
      owner: ["ReplicaSet", "legacy-app-84f6d5c7b9"],
      ageMs: 2 * HOUR,
      state: {
        waiting: {
          reason: "ImagePullBackOff",
          message: 'Back-off pulling image "registry.example.lan/apps/legacy:0.9"',
        },
      },
    }),
    pod({
      ns: s.completed.namespace,
      name: s.completed.name,
      node: "worker-1",
      phase: "Succeeded",
      ready: false,
      owner: ["Job", "nightly-db-dump-29326800"],
      ageMs: 9 * HOUR,
      state: {
        terminated: { exitCode: 0, reason: "Completed", startedAt: ago(9 * HOUR), finishedAt: ago(9 * HOUR - 41_000) },
      },
    }),
    pod({
      ns: "databases",
      name: "postgres-0",
      node: "worker-1",
      owner: ["StatefulSet", "postgres"],
      pvc: "data-postgres-0",
      ageMs: 30 * DAY,
    }),
    pod({
      ns: "media",
      name: "jellyfin-0",
      node: "worker-1",
      owner: ["StatefulSet", "jellyfin"],
      pvc: "media-library",
      ageMs: 30 * DAY,
    }),
    pod({
      ns: "default",
      name: "uploads-api-5c6d8f7b9-n2m4k",
      node: "cp-1",
      owner: ["ReplicaSet", "uploads-api-5c6d8f7b9"],
      pvc: "uploads",
    }),
    pod({
      ns: "kube-system",
      name: "coredns-5d78c9869d-v7k2j",
      node: "cp-1",
      owner: ["ReplicaSet", "coredns-5d78c9869d"],
      ageMs: 60 * DAY,
    }),
    pod({
      ns: "kube-system",
      name: "metrics-server-6f4c6675d5-c8b9w",
      node: "cp-1",
      owner: ["ReplicaSet", "metrics-server-6f4c6675d5"],
      ageMs: 60 * DAY,
    }),
    ...longhornPods,
    pod({ ns: "velero", name: "velero-7c9d5f6b8-zq4x7", node: "worker-1", owner: ["ReplicaSet", "velero-7c9d5f6b8"] }),
    pod({
      ns: "cattle-fleet-system",
      name: "fleet-controller-6d7f8c9b5-j5h2l",
      node: "cp-1",
      owner: ["ReplicaSet", "fleet-controller-6d7f8c9b5"],
    }),
    pod({
      ns: "cert-manager",
      name: "cert-manager-8b9c7d6f5-w2n4p",
      node: "cp-1",
      owner: ["ReplicaSet", "cert-manager-8b9c7d6f5"],
    }),
  ];
}

function events(): Json[] {
  const ev = (
    ns: string,
    kind: string,
    obj: string,
    type: string,
    reason: string,
    message: string,
    count: number,
    lastMs: number,
    component: string
  ): Json =>
    item("v1", "Event", {
      metadata: meta(
        `${obj}.${uid(reason + obj)
          .slice(0, 16)
          .replaceAll("-", "")}`,
        ns,
        {},
        lastMs
      ),
      involvedObject: {
        kind,
        name: obj,
        namespace: ns,
        uid: uid(`${kind}/${kind === "Node" ? "" : ns}/${obj}`),
        apiVersion: "v1",
      },
      reason,
      message,
      type,
      count,
      firstTimestamp: ago(lastMs + (count > 1 ? 3 * HOUR : 0)),
      lastTimestamp: ago(lastMs),
      eventTime: null,
      reportingComponent: component,
      source: { component, ...(component === "kubelet" ? { host: "worker-1" } : {}) },
    });
  const s = scenarios.pods;
  return [
    ev(
      "default",
      "Pod",
      s.crashloop.name,
      "Warning",
      "BackOff",
      "Back-off restarting failed container report-worker in pod report-worker-6c8d7f9b4-m5v2n_default(2e0f)",
      311,
      2 * MIN,
      "kubelet"
    ),
    ev(
      "default",
      "Pod",
      s.pending.name,
      "Warning",
      "FailedScheduling",
      "0/3 nodes are available: 1 node(s) had untolerated taint {node.kubernetes.io/unreachable: }, 2 Insufficient memory.",
      9,
      4 * MIN,
      "default-scheduler"
    ),
    ev(
      "default",
      "Pod",
      s.imagePull.name,
      "Warning",
      "Failed",
      'Failed to pull image "registry.example.lan/apps/legacy:0.9": rpc error: code = NotFound desc = failed to pull and unpack image: not found',
      14,
      6 * MIN,
      "kubelet"
    ),
    ev(
      "default",
      "Pod",
      s.imagePull.name,
      "Normal",
      "BackOff",
      'Back-off pulling image "registry.example.lan/apps/legacy:0.9"',
      40,
      3 * MIN,
      "kubelet"
    ),
    ev(
      "media",
      "Pod",
      "jellyfin-0",
      "Warning",
      "FailedMount",
      `MountVolume.MountDevice failed for volume "${scenarios.longhorn.degraded}" : rpc error: code = Aborted desc = volume is not ready for workloads`,
      3,
      3 * DAY,
      "kubelet"
    ),
    ev("default", "Pod", s.healthy.name, "Normal", "Started", "Started container web", 1, 5 * DAY, "kubelet"),
    ev(
      "default",
      "Node",
      "worker-2",
      "Normal",
      "NodeNotReady",
      "Node worker-2 status is now: NodeNotReady",
      1,
      22 * MIN,
      "node-controller"
    ),
    ev(
      "default",
      "Node",
      "worker-1",
      "Warning",
      "NodeHasInsufficientMemory",
      "Node worker-1 status is now: NodeHasInsufficientMemory",
      1,
      22 * MIN,
      "kubelet"
    ),
  ].map((e) => ({ ...e, metadata: { ...e.metadata, namespace: e.involvedObject.namespace } }));
}

const SC_LH = "longhorn";

function storage() {
  const pv = (vol: string, pvc: [string, string], size: number): Json =>
    item("v1", "PersistentVolume", {
      metadata: meta(vol, undefined, { annotations: {} }, 30 * DAY),
      spec: {
        accessModes: ["ReadWriteOnce"],
        capacity: { storage: `${size}Gi` },
        claimRef: { apiVersion: "v1", kind: "PersistentVolumeClaim", namespace: pvc[0], name: pvc[1] },
        csi: { driver: "driver.longhorn.io", fsType: "ext4", volumeHandle: vol },
        persistentVolumeReclaimPolicy: "Delete",
        storageClassName: SC_LH,
        volumeMode: "Filesystem",
      },
      status: { phase: "Bound" },
    });
  const pvc = (ns: string, name: string, vol: string | null, size: number): Json =>
    item("v1", "PersistentVolumeClaim", {
      metadata: meta(name, ns, { annotations: {} }, 30 * DAY),
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: `${size}Gi` } },
        storageClassName: SC_LH,
        volumeMode: "Filesystem",
        ...(vol ? { volumeName: vol } : {}),
      },
      status: vol
        ? { phase: "Bound", accessModes: ["ReadWriteOnce"], capacity: { storage: `${size}Gi` } }
        : { phase: "Pending" },
    });
  const l = scenarios.longhorn;
  const c = scenarios.pvcs;
  const rows: Array<[{ namespace: string; name: string }, string, number]> = [
    [c.protected, l.healthy, 10],
    [c.stale, l.degraded, 100],
    [c.failing, l.faulted, 20],
    [c.neverRun, l.detached, 5],
    [c.unprotected, l.unprotected, 2],
  ];
  return {
    pvcs: [
      ...rows.map(([ref, vol, size]) => pvc(ref.namespace, ref.name, vol, size)),
      pvc(c.pending.namespace, c.pending.name, null, 50),
    ],
    pvs: rows.map(([ref, vol, size]) => pv(vol, [ref.namespace, ref.name], size)),
    storageClasses: [
      item("storage.k8s.io/v1", "StorageClass", {
        metadata: meta(SC_LH, undefined, { annotations: {} }, 60 * DAY),
        provisioner: "driver.longhorn.io",
        allowVolumeExpansion: true,
        reclaimPolicy: "Delete",
        volumeBindingMode: "Immediate",
        parameters: { numberOfReplicas: "2", staleReplicaTimeout: "30", fsType: "ext4" },
      }),
      item("storage.k8s.io/v1", "StorageClass", {
        metadata: meta("local-path", undefined, { annotations: {} }, 60 * DAY),
        provisioner: "rancher.io/local-path",
        reclaimPolicy: "Delete",
        volumeBindingMode: "WaitForFirstConsumer",
      }),
    ],
  };
}

function workloads() {
  const dep = (ns: string, name: string, desired: number, ready: number, rs?: string): Json =>
    item("apps/v1", "Deployment", {
      metadata: meta(name, ns, { generation: 3, labels: { app: name } }),
      spec: {
        replicas: desired,
        selector: { matchLabels: { app: name } },
        strategy: { type: "RollingUpdate" },
        template: {
          metadata: { labels: { app: name } },
          spec: {
            containers: [
              { name, image: "registry.example.lan/apps/app:1.4.2", env: [{ name: "LOG_LEVEL", value: "REDACTED" }] },
            ],
          },
        },
      },
      status: {
        observedGeneration: 3,
        replicas: desired,
        updatedReplicas: desired,
        readyReplicas: ready || undefined,
        availableReplicas: ready || undefined,
        unavailableReplicas: desired - ready || undefined,
        conditions: [
          {
            type: "Available",
            status: ready >= 1 ? "True" : "False",
            reason: ready >= 1 ? "MinimumReplicasAvailable" : "MinimumReplicasUnavailable",
            lastTransitionTime: ago(DAY),
          },
          {
            type: "Progressing",
            status: "True",
            reason: rs ? "NewReplicaSetAvailable" : "ReplicaSetUpdated",
            lastTransitionTime: ago(DAY),
          },
        ],
      },
    });
  const rsOf = (ns: string, name: string, hash: string, desired: number, ready: number): Json =>
    item("apps/v1", "ReplicaSet", {
      metadata: meta(`${name}-${hash}`, ns, {
        labels: { app: name, "pod-template-hash": hash },
        ownerReferences: [
          {
            apiVersion: "apps/v1",
            kind: "Deployment",
            name,
            uid: uid(`Deployment/${ns}/${name}`),
            controller: true,
            blockOwnerDeletion: true,
          },
        ],
      }),
      spec: { replicas: desired, selector: { matchLabels: { app: name, "pod-template-hash": hash } } },
      status: {
        replicas: desired,
        readyReplicas: ready || undefined,
        availableReplicas: ready || undefined,
        observedGeneration: 1,
      },
    });
  const sts = (ns: string, name: string): Json =>
    item("apps/v1", "StatefulSet", {
      metadata: meta(name, ns, { labels: { app: name } }, 30 * DAY),
      spec: { replicas: 1, serviceName: name, selector: { matchLabels: { app: name } } },
      status: {
        replicas: 1,
        readyReplicas: 1,
        currentReplicas: 1,
        updatedReplicas: 1,
        availableReplicas: 1,
        observedGeneration: 1,
      },
    });
  const ds = (ns: string, name: string, desired: number, ready: number): Json =>
    item("apps/v1", "DaemonSet", {
      metadata: meta(name, ns, { labels: { app: name } }, 40 * DAY),
      spec: { selector: { matchLabels: { app: name } } },
      status: {
        desiredNumberScheduled: desired,
        currentNumberScheduled: desired,
        numberReady: ready,
        numberAvailable: ready,
        numberMisscheduled: 0,
        updatedNumberScheduled: desired,
        observedGeneration: 1,
      },
    });
  const job = (name: string, ok: boolean, ageMs: number): Json =>
    item("batch/v1", "Job", {
      metadata: meta(
        name,
        "default",
        {
          ownerReferences: [
            {
              apiVersion: "batch/v1",
              kind: "CronJob",
              name: "nightly-db-dump",
              uid: uid("CronJob/default/nightly-db-dump"),
              controller: true,
            },
          ],
        },
        ageMs
      ),
      spec: { completions: 1, parallelism: 1, backoffLimit: 6 },
      status: ok
        ? {
            succeeded: 1,
            startTime: ago(ageMs),
            completionTime: ago(ageMs - 41_000),
            conditions: [{ type: "Complete", status: "True", lastTransitionTime: ago(ageMs - 41_000) }],
          }
        : {
            failed: 7,
            startTime: ago(ageMs),
            conditions: [
              {
                type: "Failed",
                status: "True",
                reason: "BackoffLimitExceeded",
                message: "Job has reached the specified backoff limit",
                lastTransitionTime: ago(ageMs - HOUR),
              },
            ],
          },
    });
  return {
    deployments: [
      dep("default", "web", 2, 2, "ok"),
      dep("default", "report-worker", 1, 0),
      dep("default", "batch-import", 1, 0),
      dep("default", "legacy-app", 1, 0),
      dep("default", "uploads-api", 1, 1, "ok"),
      dep("kube-system", "coredns", 1, 1, "ok"),
      dep("kube-system", "metrics-server", 1, 1, "ok"),
      dep("velero", "velero", 1, 1, "ok"),
      dep("cattle-fleet-system", "fleet-controller", 1, 1, "ok"),
      dep("cert-manager", "cert-manager", 1, 1, "ok"),
    ],
    replicaSets: [
      rsOf("default", "web", "7d9f8b6c5d", 2, 2),
      rsOf("kube-system", "coredns", "5d78c9869d", 1, 1),
      rsOf("kube-system", "metrics-server", "6f4c6675d5", 1, 1),
      rsOf("velero", "velero", "7c9d5f6b8", 1, 1),
      rsOf("cattle-fleet-system", "fleet-controller", "6d7f8c9b5", 1, 1),
      rsOf("cert-manager", "cert-manager", "8b9c7d6f5", 1, 1),
      rsOf("default", "report-worker", "6c8d7f9b4", 1, 0),
      rsOf("default", "batch-import", "5b7c9d8f6", 1, 0),
      rsOf("default", "legacy-app", "84f6d5c7b9", 1, 0),
    ],
    statefulSets: [sts("databases", "postgres"), sts("media", "jellyfin")],
    daemonSets: [ds("longhorn-system", "longhorn-manager", 3, 2)],
    jobs: [job("nightly-db-dump-29326800", true, 9 * HOUR), job("nightly-db-dump-29325360", false, 33 * HOUR)],
    cronJobs: [
      item("batch/v1", "CronJob", {
        metadata: meta("nightly-db-dump", "default"),
        spec: { schedule: "0 3 * * *", concurrencyPolicy: "Forbid", suspend: false },
        status: { lastScheduleTime: ago(9 * HOUR), lastSuccessfulTime: ago(9 * HOUR - 41_000) },
      }),
    ],
  };
}

const LH = "longhorn.io/v1beta2";

function longhorn() {
  const l = scenarios.longhorn;
  const c = scenarios.pvcs;
  const vol = (
    name: string,
    pvc: { namespace: string; name: string },
    sizeGi: number,
    state: string,
    robustness: string,
    node: string | undefined,
    opts: { used: number; lastBackup?: string; lastBackupAt?: string; jobs?: string[]; replicas?: number }
  ): Json =>
    item(LH, "Volume", {
      metadata: meta(
        name,
        "longhorn-system",
        {
          labels: {
            longhornvolume: name,
            ...Object.fromEntries((opts.jobs ?? []).map((j) => [`recurring-job.longhorn.io/${j}`, "enabled"])),
          },
          finalizers: ["longhorn.io"],
        },
        30 * DAY
      ),
      spec: {
        size: gi(sizeGi),
        numberOfReplicas: opts.replicas ?? 2,
        frontend: "blockdev",
        accessMode: "rwo",
        dataEngine: "v1",
        staleReplicaTimeout: 30,
        nodeID: node ?? "",
        migratable: false,
        revisionCounterDisabled: true,
      },
      status: {
        state,
        robustness,
        currentNodeID: node ?? "",
        ownerID: "cp-1",
        actualSize: gi(opts.used),
        lastBackup: opts.lastBackup ?? "",
        lastBackupAt: opts.lastBackupAt ?? "",
        restoreRequired: false,
        kubernetesStatus: {
          pvName: name,
          pvStatus: "Bound",
          pvcName: pvc.name,
          namespace: pvc.namespace,
          lastPVCRefAt: "",
          lastPodRefAt: "",
          ...(node
            ? {
                workloadsStatus: [
                  { podName: "workload", podStatus: "Running", workloadName: pvc.name, workloadType: "StatefulSet" },
                ],
              }
            : {}),
        },
        conditions: [
          {
            type: "Scheduled",
            status: robustness === "faulted" ? "False" : "True",
            reason: robustness === "faulted" ? "ReplicaSchedulingFailure" : "",
            lastTransitionTime: ago(DAY),
          },
          { type: "Restore", status: "False", reason: "", lastTransitionTime: "" },
        ],
      },
    });
  const volumes = [
    vol(l.healthy, c.protected, 10, "attached", "healthy", "worker-1", {
      used: 3,
      lastBackup: "backup-1b2c3d4e5f607182",
      lastBackupAt: ago(10 * HOUR),
      jobs: ["db-backup"],
    }),
    vol(l.degraded, c.stale, 100, "attached", "degraded", "worker-1", {
      used: 93,
      lastBackup: "backup-0a1b2c3d4e5f6071",
      lastBackupAt: ago(9 * DAY),
      jobs: ["media-backup"],
      replicas: 2,
    }),
    vol(l.faulted, c.failing, 20, "detached", "faulted", undefined, {
      used: 6,
      lastBackup: "backup-77ac9e0c1d2f3a45",
      lastBackupAt: ago(4 * DAY),
      jobs: ["db-backup"],
    }),
    vol(l.detached, c.neverRun, 5, "detached", "unknown", undefined, { used: 1, jobs: ["db-backup"] }),
    vol(l.unprotected, c.unprotected, 2, "attached", "healthy", "cp-1", { used: 1 }),
  ];
  const backup = (hex: string, volume: string, state: string, ageMs: number, sizeGi: number, error?: string): Json =>
    item(LH, "Backup", {
      metadata: meta(
        `backup-${hex}`,
        "longhorn-system",
        { labels: { "backup-volume": volume, longhornvolume: volume }, finalizers: ["longhorn.io"] },
        ageMs
      ),
      spec: {
        snapshotName: `snapshot-${hex}`,
        labels: { RecurringJob: volume === l.degraded ? "media-backup" : "db-backup" },
        syncRequestedAt: null,
      },
      status: {
        state,
        ownerID: "cp-1",
        progress: state === "Completed" ? 100 : 37,
        size: state === "Completed" ? gi(sizeGi) : "0",
        snapshotCreatedAt: ago(ageMs),
        backupCreatedAt: state === "Completed" ? ago(ageMs - 3 * MIN) : "",
        lastSyncedAt: ago(2 * MIN),
        url: `nfs://nas.example.lan:/volume1/longhorn?backup=backup-${hex}&volume=${volume}`,
        volumeName: volume,
        volumeSize: gi(sizeGi),
        messages: error ? { error } : null,
        ...(error ? { error } : {}),
      },
    });
  const backups = [
    backup("1b2c3d4e5f607182", l.healthy, "Completed", 10 * HOUR, 3),
    backup("2c3d4e5f60718293", l.healthy, "Completed", 34 * HOUR, 3),
    backup("0a1b2c3d4e5f6071", l.degraded, "Completed", 9 * DAY, 90),
    backup("77ac9e0c1d2f3a45", l.faulted, "Completed", 4 * DAY, 6),
    backup(
      "88bd0f1d2e304b56",
      l.faulted,
      "Error",
      6 * HOUR,
      6,
      "failed to execute: /engine-binaries/longhornio-longhorn-engine-v1.7.2/longhorn [--url 10.42.1.14:10000 backup create], output Error: dial tcp: connection refused"
    ),
  ];
  const backupVolume = (volume: string, last: string, lastAt: string, sizeGi: number, pvc: string): Json =>
    item(LH, "BackupVolume", {
      metadata: meta(
        volume,
        "longhorn-system",
        { labels: { "backup-target": "default", longhornvolume: volume }, finalizers: ["longhorn.io"] },
        30 * DAY
      ),
      spec: { syncRequestedAt: null },
      status: {
        backingImageName: "",
        backingImageChecksum: "",
        createdAt: ago(30 * DAY),
        dataStored: gi(sizeGi),
        labels: { KubernetesStatus: JSON.stringify({ pvName: volume, pvcName: pvc }) },
        lastBackupAt: lastAt,
        lastBackupName: last,
        lastModificationTime: lastAt,
        lastSyncedAt: ago(2 * MIN),
        messages: null,
        ownerID: "cp-1",
        size: gi(sizeGi),
        storageClassName: SC_LH,
      },
    });
  const target = (name: string, url: string, available: boolean, message: string): Json =>
    item(LH, "BackupTarget", {
      metadata: meta(name, "longhorn-system", { finalizers: ["longhorn.io"] }, 60 * DAY),
      spec: {
        backupTargetURL: url,
        credentialSecret: available ? "" : "offsite-credentials",
        pollInterval: "5m0s",
        syncRequestedAt: null,
      },
      status: {
        available,
        lastSyncedAt: available ? ago(2 * MIN) : ago(DAY),
        ownerID: "cp-1",
        conditions: [
          {
            type: "Unavailable",
            status: available ? "False" : "True",
            reason: available ? "" : "BackupTargetError",
            message,
            lastTransitionTime: ago(available ? 60 * DAY : DAY),
            lastProbeTime: "",
          },
        ],
      },
    });
  const rj = (name: string, task: string, cron: string, retain: number): Json =>
    item(LH, "RecurringJob", {
      metadata: meta(name, "longhorn-system", { finalizers: ["longhorn.io"] }, 60 * DAY),
      spec: { name, groups: [], task, cron, retain, concurrency: 2, labels: { RecurringJob: name } },
      status: { executionCount: 41, ownerID: "cp-1" },
    });
  const GI = 1024 ** 3;
  const lhNode = (name: string, ready: boolean, availablePct: number, scheduled: Record<string, number>): Json => {
    const diskId = `default-disk-${uid(name).replaceAll("-", "").slice(0, 16)}`;
    const maximum = 100 * GI;
    const low = availablePct < 25;
    const diskCondition = (type: string, ok: boolean, reason: string, message: string): Json => ({
      type,
      status: ok ? "True" : "False",
      reason,
      message,
      lastTransitionTime: ago(low || !ready ? 40 * MIN : 30 * DAY),
    });
    return item(LH, "Node", {
      metadata: meta(name, "longhorn-system", { finalizers: ["longhorn.io"] }, 60 * DAY),
      spec: {
        name,
        allowScheduling: true,
        evictionRequested: false,
        instanceManagerCPURequest: 0,
        tags: [],
        disks: {
          [diskId]: {
            path: "/var/lib/longhorn/",
            allowScheduling: true,
            diskType: "filesystem",
            evictionRequested: false,
            storageReserved: 30 * GI,
            tags: [],
          },
        },
      },
      status: {
        region: "",
        zone: "",
        snapshotCheckStatus: {},
        autoEvicting: false,
        conditions: [
          diskCondition(
            "Ready",
            ready,
            ready ? "" : "KubernetesNodeNotReady",
            ready ? "" : `Kubernetes node ${name} is not ready`
          ),
          diskCondition("Schedulable", ready, "", ""),
          diskCondition("MountPropagation", true, "", `Node ${name} is managed by Longhorn`),
        ],
        diskStatus: {
          [diskId]: {
            diskName: diskId,
            diskPath: "/var/lib/longhorn/",
            diskType: "filesystem",
            diskUUID: uid(`disk-${name}`),
            filesystemType: "ext2/ext3",
            storageAvailable: Math.round((maximum * availablePct) / 100),
            storageMaximum: maximum,
            storageScheduled: Object.values(scheduled).reduce((a, b) => a + b, 0) * GI,
            scheduledReplica: Object.fromEntries(Object.entries(scheduled).map(([r, g]) => [r, g * GI])),
            conditions: [
              diskCondition("Ready", ready, ready ? "" : "NodeDown", ""),
              diskCondition(
                "Schedulable",
                !low && ready,
                low ? "DiskPressure" : "",
                low
                  ? `Disk ${diskId} (/var/lib/longhorn/) on the node ${name} has ${availablePct}% available, less than the 25% minimum`
                  : ""
              ),
            ],
          },
        },
      },
    });
  };
  const replica = (volume: string, hex: string, node: string, running: boolean, failedAgoMs?: number): Json => {
    const name = `${volume}-r-${hex}`;
    return item(LH, "Replica", {
      metadata: meta(
        name,
        "longhorn-system",
        { labels: { longhornvolume: volume, longhornnode: node }, finalizers: ["longhorn.io"] },
        30 * DAY
      ),
      spec: {
        volumeName: volume,
        volumeSize: "0",
        nodeID: node,
        diskPath: "/var/lib/longhorn/",
        dataDirectoryName: `${volume}-${hex}`,
        engineName: `${volume}-e-0`,
        desireState: running ? "running" : "stopped",
        active: true,
        failedAt: failedAgoMs ? ago(failedAgoMs) : "",
        healthyAt: failedAgoMs ? ago(failedAgoMs + DAY) : ago(30 * DAY),
        image: "longhornio/longhorn-engine:v1.7.2",
        dataEngine: "v1",
        rebuildRetryCount: 0,
      },
      status: {
        currentState: running ? "running" : "stopped",
        currentImage: running ? "longhornio/longhorn-engine:v1.7.2" : "",
        instanceManagerName: running ? `instance-manager-${node}` : "",
        ownerID: node,
        started: running,
        port: running ? 10000 + parseInt(hex.slice(0, 2), 16) : 0,
        storageIP: "",
        ip: "",
      },
    });
  };
  const snapshot = (volume: string, hex: string, ageMs: number, error?: string): Json =>
    item(LH, "Snapshot", {
      metadata: meta(
        `snapshot-${hex}`,
        "longhorn-system",
        { labels: { longhornvolume: volume }, finalizers: ["longhorn.io"] },
        ageMs
      ),
      spec: { volume, createSnapshot: true, labels: { RecurringJob: "hourly-snap" } },
      status: {
        parent: "",
        children: { volumeHead: true },
        markRemoved: false,
        userCreated: false,
        creationTime: error ? "" : ago(ageMs),
        size: error ? "0" : String(2 * GI),
        labels: { RecurringJob: "hourly-snap" },
        readyToUse: !error,
        restoreSize: error ? 0 : 20 * GI,
        checksum: "",
        error: error ?? "",
        ownerID: "cp-1",
      },
    });
  const setting = (name: string, value: string): Json =>
    item(LH, "Setting", { metadata: meta(name, "longhorn-system", {}, 60 * DAY), value, status: { applied: true } });
  return {
    volumes,
    nodes: [
      lhNode("cp-1", true, 62, { [`${l.healthy}-r-9d3c`]: 10, [`${l.unprotected}-r-1c9d`]: 2 }),
      lhNode("worker-1", true, 15, {
        [`${l.healthy}-r-4f1a`]: 10,
        [`${l.degraded}-r-7b2e`]: 100,
        [`${l.unprotected}-r-3e5a`]: 2,
      }),
      lhNode("worker-2", false, 48, { [`${l.degraded}-r-2a8f`]: 100 }),
    ],
    replicas: [
      replica(l.healthy, "4f1a", "worker-1", true),
      replica(l.healthy, "9d3c", "cp-1", true),
      replica(l.degraded, "7b2e", "worker-1", true),
      // worker-2 went down: the second replica is stopped and marked failed.
      replica(l.degraded, "2a8f", "worker-2", false, 22 * MIN),
      replica(l.faulted, "5e6d", "worker-1", false, 3 * HOUR),
      replica(l.faulted, "8c4b", "worker-2", false, 3 * HOUR),
      replica(l.unprotected, "1c9d", "cp-1", true),
      replica(l.unprotected, "3e5a", "worker-1", true),
    ],
    snapshots: [
      snapshot(l.healthy, "1b2c3d4e5f607182", 10 * HOUR),
      snapshot(l.degraded, "0a1b2c3d4e5f6071", 9 * DAY),
      snapshot(
        l.faulted,
        "99ce1f2e3f415c67",
        6 * HOUR,
        "failed to take snapshot: cannot create snapshot, volume is faulted: no healthy replica"
      ),
    ],
    backups,
    backupVolumes: [
      backupVolume(l.healthy, "backup-1b2c3d4e5f607182", ago(10 * HOUR), 3, c.protected.name),
      backupVolume(l.degraded, "backup-0a1b2c3d4e5f6071", ago(9 * DAY), 90, c.stale.name),
      backupVolume(l.faulted, "backup-77ac9e0c1d2f3a45", ago(4 * DAY), 6, c.failing.name),
    ],
    backupTargets: [
      target("default", "nfs://nas.example.lan:/volume1/longhorn", true, ""),
      target(
        "offsite",
        "s3://offsite-backups@eu-west-1/longhorn",
        false,
        "failed to execute: /engine-binaries/longhorn [backup ls], output Error: AWS Error: AccessDenied status code: 403"
      ),
    ],
    recurringJobs: [
      rj("db-backup", "backup", "0 2 * * *", 14),
      rj("media-backup", "backup", "30 2 * * 0", 4),
      rj("hourly-snap", "snapshot", "0 * * * *", 6),
    ],
    settings: [
      setting("backup-target", "nfs://nas.example.lan:/volume1/longhorn"),
      setting("default-replica-count", '{"v1":"2","v2":"2"}'),
      setting("storage-minimal-available-percentage", "25"),
      setting("backupstore-poll-interval", "300"),
    ],
  };
}

function velero() {
  const v = scenarios.velero;
  const backup = (name: string, schedule: string, phase: string, ageMs: number, ns: string[], extra: Json = {}): Json =>
    item("velero.io/v1", "Backup", {
      metadata: meta(
        name,
        "velero",
        {
          labels: { "velero.io/schedule-name": schedule, "velero.io/storage-location": "default" },
          annotations: {
            "velero.io/source-cluster-k8s-gitversion": "v1.31.4+k3s1",
            "velero.io/source-cluster-k8s-major-version": "1",
            "velero.io/source-cluster-k8s-minor-version": "31",
          },
          finalizers: ["velero.io/delete-backup"],
        },
        ageMs
      ),
      spec: {
        csiSnapshotTimeout: "10m0s",
        defaultVolumesToFsBackup: true,
        hooks: {},
        includedNamespaces: ns,
        itemOperationTimeout: "4h0m0s",
        metadata: {},
        snapshotMoveData: false,
        storageLocation: "default",
        ttl: "720h0m0s",
      },
      status: {
        version: 1,
        formatVersion: "1.1.0",
        expiration: ahead(30 * DAY - ageMs),
        startTimestamp: ago(ageMs),
        completionTimestamp: phase === "InProgress" ? undefined : ago(ageMs - 3 * MIN),
        phase,
        progress: { totalItems: 212, itemsBackedUp: phase === "Failed" ? 41 : 212 },
        ...extra,
      },
    });
  const bsl = (name: string, available: boolean, config: Json): Json =>
    item("velero.io/v1", "BackupStorageLocation", {
      metadata: meta(name, "velero", { finalizers: ["velero.io/bsl-controller-finalizer"] }, 60 * DAY),
      spec: {
        accessMode: "ReadWrite",
        config,
        default: name === "default",
        objectStorage: { bucket: name === "default" ? "velero" : "offsite-velero", prefix: "cluster" },
        provider: "aws",
      },
      status: available
        ? { phase: "Available", lastSyncedTime: ago(MIN), lastValidationTime: ago(MIN), accessMode: "ReadWrite" }
        : {
            phase: "Unavailable",
            lastSyncedTime: ago(2 * DAY),
            lastValidationTime: ago(MIN),
            message: `BackupStorageLocation "${name}" is unavailable: rpc error: code = Unknown desc = RequestError: send request failed caused by: Get "https://s3.eu-west-1.amazonaws.com/offsite-velero": dial tcp: i/o timeout`,
          },
    });
  return {
    backups: [
      backup(v.completed, "daily-databases", "Completed", 10 * HOUR, ["databases"], { warnings: 1 }),
      backup(v.partial, "daily-media", "PartiallyFailed", 34 * HOUR, ["media"], { errors: 3, warnings: 2 }),
      backup(v.failed, "daily-default", "Failed", 3 * DAY, ["default"], {
        failureReason:
          "get a backup with BackupStorageLocation default and cannot get a backup store: rpc error: code = Unknown desc = RequestError: dial tcp 192.168.10.5:9000: connect: connection refused",
        errors: 1,
      }),
    ],
    schedules: [
      item("velero.io/v1", "Schedule", {
        metadata: meta(v.schedule, "velero"),
        spec: {
          schedule: "0 2 * * *",
          template: { includedNamespaces: ["databases"], storageLocation: "default", ttl: "720h0m0s" },
          useOwnerReferencesInBackup: false,
        },
        status: { phase: "Enabled", lastBackup: ago(10 * HOUR) },
      }),
      item("velero.io/v1", "Schedule", {
        metadata: meta("daily-media", "velero"),
        spec: {
          schedule: "0 2 * * *",
          template: { includedNamespaces: ["media"], storageLocation: "default", ttl: "720h0m0s" },
        },
        status: { phase: "Enabled", lastBackup: ago(34 * HOUR) },
      }),
    ],
    restores: [
      item("velero.io/v1", "Restore", {
        metadata: meta(
          v.restore,
          "velero",
          { finalizers: ["restores.velero.io/external-resources-finalizer"] },
          7 * DAY
        ),
        spec: {
          backupName: "daily-databases-20260929-020011",
          includedNamespaces: ["databases"],
          itemOperationTimeout: "4h0m0s",
          namespaceMapping: { databases: "databases-restore-test" },
        },
        status: {
          phase: "Completed",
          startTimestamp: ago(7 * DAY),
          completionTimestamp: ago(7 * DAY - 5 * MIN),
          progress: { totalItems: 64, itemsRestored: 64 },
          warnings: 2,
        },
      }),
    ],
    backupStorageLocations: [
      bsl(v.locationAvailable, true, {
        region: "minio",
        s3ForcePathStyle: "true",
        s3Url: "http://nas.example.lan:9000",
      }),
      bsl(v.locationUnavailable, false, { region: "eu-west-1" }),
    ],
  };
}

function fleet() {
  const f = scenarios.fleet;
  const repo = (name: string, path: string, ready: boolean): Json =>
    item("fleet.cattle.io/v1alpha1", "GitRepo", {
      metadata: meta(name, "fleet-default", { finalizers: ["fleet.cattle.io/gitrepo-finalizer"] }, 45 * DAY),
      spec: {
        branch: "main",
        clientSecretName: "gitea-auth",
        paths: [path],
        repo: "https://REDACTED@git.example.lan/ops/cluster.git",
        targets: [{ clusterSelector: {} }],
      },
      status: {
        commit: "4f9a1c7e2b3d5a60918f7e6d5c4b3a291807f6e5",
        desiredReadyClusters: 1,
        readyClusters: ready ? 1 : 0,
        gitJobStatus: "Current",
        display: {
          readyBundleDeployments: ready ? "1/1" : "0/1",
          state: ready ? "Ready" : "NotReady",
          message: ready ? "" : "NotReady(1) [Bundle cluster-addons-cert-issuers]",
          error: !ready,
        },
        summary: ready
          ? { desiredReady: 1, ready: 1 }
          : {
              desiredReady: 1,
              ready: 0,
              notReady: 1,
              nonReadyResources: [
                {
                  name: "cluster-addons-cert-issuers",
                  state: "NotReady",
                  bundleState: "NotReady",
                  message: "Resource: cert-manager.io/v1, Kind=ClusterIssuer, letsencrypt: not ready",
                },
              ],
            },
        conditions: [
          {
            type: "Ready",
            status: ready ? "True" : "False",
            lastUpdateTime: ago(5 * MIN),
            ...(ready ? {} : { reason: "NotReady", message: "NotReady(1) [Bundle cluster-addons-cert-issuers]" }),
          },
          { type: "Accepted", status: "True", lastUpdateTime: ago(5 * MIN) },
        ],
      },
    });
  const bundle = (name: string, repoName: string, ready: boolean): Json =>
    item("fleet.cattle.io/v1alpha1", "Bundle", {
      metadata: meta(
        name,
        "fleet-default",
        {
          labels: { "fleet.cattle.io/commit": "4f9a1c7e2b3d", "fleet.cattle.io/repo-name": repoName },
          annotations: {},
          ownerReferences: [
            {
              apiVersion: "fleet.cattle.io/v1alpha1",
              kind: "GitRepo",
              name: repoName,
              uid: uid(`GitRepo/fleet-default/${repoName}`),
              controller: true,
            },
          ],
        },
        45 * DAY
      ),
      spec: {
        resources: [{ name: "kustomization.yaml" }, { name: "deployment.yaml" }],
        helm: { values: {} },
        targets: [{ clusterName: "local" }],
      },
      status: {
        display: { readyClusters: ready ? "1/1" : "0/1", state: ready ? "Ready" : "NotReady" },
        summary: ready ? { desiredReady: 1, ready: 1 } : { desiredReady: 1, ready: 0, notReady: 1 },
        conditions: [
          {
            type: "Ready",
            status: ready ? "True" : "False",
            lastUpdateTime: ago(5 * MIN),
            ...(ready
              ? {}
              : { message: "NotReady(1) [Cluster local]; clusterissuer.cert-manager.io letsencrypt [not ready]" }),
          },
        ],
        resourceKey: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", namespace: "default" }],
      },
    });
  return {
    gitRepos: [repo(f.ready, "apps", true), repo(f.notReady, "addons", false)],
    bundles: [bundle(`${f.ready}-web`, f.ready, true), bundle(`${f.notReady}-cert-issuers`, f.notReady, false)],
  };
}

function certificates(): Json[] {
  const c = scenarios.certificates;
  const cert = (name: string, ns: string, ready: boolean, notAfterMs: number, message: string, reason: string): Json =>
    item("cert-manager.io/v1", "Certificate", {
      metadata: meta(name, ns, { annotations: {} }, 80 * DAY),
      spec: {
        secretName: name,
        dnsNames: [`${name.replace(/-tls$/, "")}.example.lan`],
        issuerRef: { name: "letsencrypt", kind: "ClusterIssuer", group: "cert-manager.io" },
        duration: "2160h0m0s",
        renewBefore: "720h0m0s",
      },
      status: {
        conditions: [
          {
            type: "Ready",
            status: ready ? "True" : "False",
            reason,
            message,
            observedGeneration: 1,
            lastTransitionTime: ago(DAY),
          },
        ],
        ...(notAfterMs
          ? {
              notBefore: ago(90 * DAY - notAfterMs),
              notAfter: ahead(notAfterMs),
              renewalTime: ahead(notAfterMs - 30 * DAY),
              revision: 3,
            }
          : {}),
      },
    });
  return [
    cert(c.healthy, "default", true, 61 * DAY, "Certificate is up to date and has not expired", "Ready"),
    cert(c.expiring, "default", true, 5 * DAY, "Certificate is up to date and has not expired", "Ready"),
    cert(c.notReady, "default", false, 0, "Issuing certificate as Secret does not exist", "DoesNotExist"),
  ];
}

const usage = (cpuM: number, memMi: number) => ({ cpu: `${cpuM * 1_000_000}n`, memory: `${memMi * 1024}Ki` });

function metrics() {
  const nodeMetric = (name: string, cpuM: number, memMi: number): Json => ({
    metadata: { name, creationTimestamp: ago(30_000) },
    timestamp: ago(30_000),
    window: "20.043s",
    usage: usage(cpuM, memMi),
  });
  const podMetric = (ns: string, name: string, cs: Array<[string, number, number]>): Json => ({
    metadata: { name, namespace: ns, creationTimestamp: ago(30_000) },
    timestamp: ago(30_000),
    window: "17.2s",
    containers: cs.map(([n, c, m]) => ({ name: n, usage: usage(c, m) })),
  });
  return {
    nodes: {
      apiVersion: "metrics.k8s.io/v1beta1",
      kind: "NodeMetricsList",
      metadata: {},
      items: [nodeMetric("cp-1", 412, 3120), nodeMetric("worker-1", 1830, 15210)],
    },
    pods: {
      apiVersion: "metrics.k8s.io/v1beta1",
      kind: "PodMetricsList",
      metadata: {},
      items: [
        podMetric("default", scenarios.pods.healthy.name, [["web", 12, 88]]),
        podMetric("databases", "postgres-0", [["postgres", 85, 612]]),
        podMetric("media", "jellyfin-0", [["jellyfin", 310, 1480]]),
      ],
    },
  };
}

function kubelet(): Record<string, unknown> {
  const t = ago(15_000);
  const summary = (
    node: string,
    cpuN: number,
    memBytes: number,
    fsUsedGi: number,
    volumes: Array<{ ns: string; pod: string; pvc: string; capGi: number; usedGi: number }>
  ) => ({
    node: {
      nodeName: node,
      systemContainers: [
        {
          name: "kubelet",
          startTime: ago(60 * DAY),
          cpu: { time: t, usageNanoCores: 24_000_000, usageCoreNanoSeconds: 912_000_000_000 },
          memory: { time: t, usageBytes: 120_000_000, workingSetBytes: 110_000_000, rssBytes: 90_000_000 },
        },
      ],
      startTime: ago(60 * DAY),
      cpu: { time: t, usageNanoCores: cpuN, usageCoreNanoSeconds: cpuN * 4_000_000 },
      memory: {
        time: t,
        availableBytes: 16_650_000_000 - memBytes,
        usageBytes: memBytes + 2e9,
        workingSetBytes: memBytes,
        rssBytes: memBytes - 1e9,
        pageFaults: 1_204_881,
        majorPageFaults: 311,
      },
      network: {
        time: t,
        name: "eth0",
        rxBytes: 48_120_331_904,
        rxErrors: 0,
        txBytes: 21_700_118_222,
        txErrors: 0,
        interfaces: [{ name: "eth0", rxBytes: 48_120_331_904, rxErrors: 0, txBytes: 21_700_118_222, txErrors: 0 }],
      },
      fs: {
        time: t,
        availableBytes: (100 - fsUsedGi) * 1024 ** 3,
        capacityBytes: 100 * 1024 ** 3,
        usedBytes: fsUsedGi * 1024 ** 3,
        inodesFree: 6_100_000,
        inodes: 6_553_600,
        inodesUsed: 453_600,
      },
      runtime: {
        imageFs: {
          time: t,
          availableBytes: (100 - fsUsedGi) * 1024 ** 3,
          capacityBytes: 100 * 1024 ** 3,
          usedBytes: 14 * 1024 ** 3,
          inodesFree: 6_100_000,
          inodes: 6_553_600,
          inodesUsed: 453_600,
        },
      },
      rlimit: { time: t, maxpid: 4194304, curproc: 412 },
    },
    pods: volumes.map((v) => ({
      podRef: { name: v.pod, namespace: v.ns, uid: uid(`Pod/${v.ns}/${v.pod}`) },
      startTime: ago(30 * DAY),
      containers: [
        {
          name: "app",
          startTime: ago(30 * DAY),
          cpu: { time: t, usageNanoCores: 20_000_000, usageCoreNanoSeconds: 5e11 },
          memory: { time: t, usageBytes: 3e8, workingSetBytes: 2.5e8, rssBytes: 2e8 },
        },
      ],
      cpu: { time: t, usageNanoCores: 20_000_000, usageCoreNanoSeconds: 5e11 },
      memory: { time: t, usageBytes: 3e8, workingSetBytes: 2.5e8, rssBytes: 2e8 },
      network: { time: t, name: "eth0", rxBytes: 1e9, rxErrors: 0, txBytes: 8e8, txErrors: 0 },
      volume: [
        {
          time: t,
          name: "data",
          availableBytes: (v.capGi - v.usedGi) * 1024 ** 3,
          capacityBytes: v.capGi * 1024 ** 3,
          usedBytes: v.usedGi * 1024 ** 3,
          inodesFree: 6_000_000,
          inodes: 6_553_600,
          inodesUsed: 553_600,
          pvcRef: { name: v.pvc, namespace: v.ns },
        },
      ],
    })),
  });
  const c = scenarios.pvcs;
  return {
    "cp-1": summary("cp-1", 412_000_000, 3_120_000_000, 38, []),
    "worker-1": summary("worker-1", 1_830_000_000, 15_210_000_000, 71, [
      { ns: c.protected.namespace, pod: "postgres-0", pvc: c.protected.name, capGi: 10, usedGi: 3 },
      { ns: c.stale.namespace, pod: "jellyfin-0", pvc: c.stale.name, capGi: 100, usedGi: 93 },
    ]),
  };
}

function discovery(): Json {
  const groups: Array<[string, string]> = [
    ["apps", "v1"],
    ["batch", "v1"],
    ["storage.k8s.io", "v1"],
    ["metrics.k8s.io", "v1beta1"],
    ["longhorn.io", "v1beta2"],
    ["velero.io", "v1"],
    ["fleet.cattle.io", "v1alpha1"],
    ["cert-manager.io", "v1"],
  ];
  return {
    kind: "APIGroupList",
    apiVersion: "v1",
    groups: groups.map(([name, version]) => ({
      name,
      versions: [{ groupVersion: `${name}/${version}`, version }],
      preferredVersion: { groupVersion: `${name}/${version}`, version },
    })),
  };
}

function logs(): Record<string, string> {
  const s = scenarios.pods;
  return {
    [`logs/${s.crashloop.namespace}/${s.crashloop.name}.log`]:
      [
        "2026-10-07T11:50:58Z INFO report-worker starting",
        "2026-10-07T11:50:59Z INFO connecting to postgres.databases.svc:5432",
        '2026-10-07T11:51:02Z ERROR could not connect: password authentication failed for user "reports"',
        "2026-10-07T11:51:02Z FATAL exiting with status 1",
      ].join("\n") + "\n",
    [`logs/${s.healthy.namespace}/${s.healthy.name}.log`]:
      ["2026-10-07T11:59:01Z GET /healthz 200", "2026-10-07T11:59:31Z GET /healthz 200"].join("\n") + "\n",
  };
}

export function buildSyntheticSet(): FixtureFiles {
  const st = storage();
  const wl = workloads();
  const lh = longhorn();
  const vl = velero();
  const fl = fleet();
  const mt = metrics();
  const logFiles = logs();
  return {
    "core/version.json": {
      major: "1",
      minor: "31",
      gitVersion: "v1.31.4+k3s1",
      gitCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      gitTreeState: "clean",
      buildDate: ago(70 * DAY),
      goVersion: "go1.22.9",
      compiler: "gc",
      platform: "linux/amd64",
    },
    "core/apis.json": discovery(),
    "core/namespaces.json": list(
      "v1",
      NS.map((n) =>
        item("v1", "Namespace", {
          metadata: meta(n, undefined, { labels: { "kubernetes.io/metadata.name": n } }, 60 * DAY),
          spec: { finalizers: ["kubernetes"] },
          status: { phase: "Active" },
        })
      )
    ),
    "core/nodes.json": list("v1", nodes()),
    "core/pods.json": list("v1", pods()),
    "core/events.json": list("v1", events()),
    "core/persistentvolumeclaims.json": list("v1", st.pvcs),
    "core/persistentvolumes.json": list("v1", st.pvs),
    "storage.k8s.io/storageclasses.json": list("v1", st.storageClasses),
    "apps/deployments.json": list("v1", wl.deployments),
    "apps/statefulsets.json": list("v1", wl.statefulSets),
    "apps/daemonsets.json": list("v1", wl.daemonSets),
    "apps/replicasets.json": list("v1", wl.replicaSets),
    "batch/jobs.json": list("v1", wl.jobs),
    "batch/cronjobs.json": list("v1", wl.cronJobs),
    "longhorn.io/volumes.json": list(LH, lh.volumes),
    "longhorn.io/nodes.json": list(LH, lh.nodes),
    "longhorn.io/replicas.json": list(LH, lh.replicas),
    "longhorn.io/snapshots.json": list(LH, lh.snapshots),
    "longhorn.io/backups.json": list(LH, lh.backups),
    "longhorn.io/backupvolumes.json": list(LH, lh.backupVolumes),
    "longhorn.io/backuptargets.json": list(LH, lh.backupTargets),
    "longhorn.io/recurringjobs.json": list(LH, lh.recurringJobs),
    "longhorn.io/settings.json": list(LH, lh.settings),
    "velero.io/backups.json": list("velero.io/v1", vl.backups),
    "velero.io/schedules.json": list("velero.io/v1", vl.schedules),
    "velero.io/restores.json": list("velero.io/v1", vl.restores),
    "velero.io/backupstoragelocations.json": list("velero.io/v1", vl.backupStorageLocations),
    "fleet.cattle.io/gitrepos.json": list("fleet.cattle.io/v1alpha1", fl.gitRepos),
    "fleet.cattle.io/bundles.json": list("fleet.cattle.io/v1alpha1", fl.bundles),
    "cert-manager.io/certificates.json": list("cert-manager.io/v1", certificates()),
    "metrics.k8s.io/nodes.json": mt.nodes,
    "metrics.k8s.io/pods.json": mt.pods,
    ...Object.fromEntries(Object.entries(kubelet()).map(([node, body]) => [`kubelet/summary-${node}.json`, body])),
    "absent.txt": "",
    ...logFiles,
  };
}

// The committed form of a fixture file. Formatted with the repo's prettier
// config so `npm run format:check` accepts the fixtures as generated.
export async function renderFixtureFile(file: string, body: unknown): Promise<string> {
  if (typeof body === "string") return body;
  const options = (await resolveConfig(file)) ?? {};
  return format(JSON.stringify(body), { ...options, parser: "json" });
}

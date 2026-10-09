import type { CatalogEntry, ClusterBasic, DetectedApp, DiscoveryReport, IngressHost } from "../../contracts/catalog.js";
import type { DeployedRelease } from "../../contracts/deploy.js";
import { isDeployedByUs } from "../../contracts/deployed.js";
import { RESOURCES, type K8sApi, type KubeObject, type ResourceRef } from "../../contracts/k8s.js";
import { POSTGRES_APP, POSTGRES_NAMESPACE, pgClusterLabel, pgClusterName } from "../../contracts/postgres.js";
import { product } from "../../product.js";
import { nodeDisks } from "./disks.js";
import { chartName, chartVersion, parseImage, signatures, type Signature } from "./signatures.js";

const DEFAULT_SC = "storageclass.kubernetes.io/is-default-class";
const DEFAULT_SC_BETA = "storageclass.beta.kubernetes.io/is-default-class";
const DEFAULT_IC = "ingressclass.kubernetes.io/is-default-class";

interface Workload extends KubeObject {
  spec?: {
    selector?: unknown;
    template?: {
      metadata?: { labels?: Record<string, string> };
      spec?: { containers?: Array<{ image?: string }>; initContainers?: Array<{ image?: string }> };
    };
  };
}

interface Backend {
  service?: { name?: string; port?: { number?: number; name?: string } };
}

interface LoadBalancerStatus {
  loadBalancer?: { ingress?: Array<{ ip?: string; hostname?: string }> };
}

interface Ingress extends KubeObject {
  spec?: {
    ingressClassName?: string;
    defaultBackend?: Backend;
    tls?: Array<{ hosts?: string[] }>;
    rules?: Array<{
      host?: string;
      http?: { paths?: Array<{ backend?: Backend }> };
    }>;
  };
  status?: LoadBalancerStatus;
}

interface Service extends KubeObject {
  spec?: {
    type?: string;
    selector?: Record<string, string>;
    ports?: Array<{ name?: string; port?: number }>;
  };
  status?: LoadBalancerStatus;
}

const INGRESS_CLASS_ANNOTATION = "kubernetes.io/ingress.class";
const MIDDLEWARES_ANNOTATION = "traefik.ingress.kubernetes.io/router.middlewares";
// The Tailscale operator's class: the Ingress has no rule host, and the
// MagicDNS name it got appears in its status.
const TAILSCALE_CLASS = "tailscale";

interface Readiness extends KubeObject {
  status?: { conditions?: Array<{ type?: string; status?: string }> };
}

interface BackupTarget extends KubeObject {
  spec?: { backupTargetURL?: string };
}

type Listed<T> = { ok: true; items: T[] } | { ok: false; absent: true } | { ok: false; absent: false; error: string };

async function listSafe<T extends KubeObject>(k8s: K8sApi, ref: ResourceRef): Promise<Listed<T>> {
  try {
    const items = await k8s.list<T>(ref);
    if (items === "absent") return { ok: false, absent: true };
    return { ok: true, items };
  } catch (err) {
    return { ok: false, absent: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const itemsOf = <T>(listed: Listed<T>): T[] => (listed.ok ? listed.items : []);
const byName = (a: KubeObject, b: KubeObject) =>
  `${a.metadata.namespace ?? ""}/${a.metadata.name}`.localeCompare(`${b.metadata.namespace ?? ""}/${b.metadata.name}`);
const qualified = (obj: KubeObject) =>
  obj.metadata.namespace ? `${obj.metadata.namespace}/${obj.metadata.name}` : obj.metadata.name;

// --- apps ----------------------------------------------------------------

interface Match {
  workload: Workload;
  kind: string;
  // 2: a label says so. 1: only an image does.
  strength: 1 | 2;
  reason: string;
  version?: string;
}

const KINDS = [
  { ref: RESOURCES.deployments, kind: "Deployment", plural: "Deployments" },
  { ref: RESOURCES.statefulSets, kind: "StatefulSet", plural: "StatefulSets" },
  { ref: RESOURCES.daemonSets, kind: "DaemonSet", plural: "DaemonSets" },
] as const;

function images(workload: Workload): string[] {
  const pod = workload.spec?.template?.spec;
  return [...(pod?.containers ?? []), ...(pod?.initContainers ?? [])].flatMap((c) => (c.image ? [c.image] : []));
}

function matchWorkload(workload: Workload, kind: string, signature: Signature): Match | null {
  const labels = workload.metadata.labels ?? {};
  const imageHit = images(workload).find((image) => signature.images.includes(parseImage(image).repo));
  const tag = imageHit ? parseImage(imageHit).tag : undefined;
  // Charts that run a floating tag carry it in the version label too
  // (cloudflared's says "latest"), which names no version.
  const label = labels["app.kubernetes.io/version"];
  const version =
    (label && label !== "latest" ? label : undefined) ??
    (tag && tag !== "latest" && !tag.startsWith("sha") ? tag : undefined);

  const chart = labels["helm.sh/chart"];
  if (chart && signature.charts.includes(chartName(chart))) {
    return { workload, kind, strength: 2, reason: `helm.sh/chart=${chart}`, version };
  }
  for (const key of ["app.kubernetes.io/name", "app"]) {
    const value = labels[key];
    if (value && signature.names.includes(value)) {
      return { workload, kind, strength: 2, reason: `${key}=${value}`, version };
    }
  }
  if (imageHit) return { workload, kind, strength: 1, reason: `image ${imageHit}`, version };
  return null;
}

interface AppMatches {
  primary?: Match;
  // Every workload of the app in the primary's namespace.
  workloads: Workload[];
}

export interface WorkloadLists {
  items: Array<{ kind: string; workload: Workload }>;
  // "Deployments could not be listed: forbidden", one per failed kind.
  failures: string[];
}

export async function listWorkloads(k8s: K8sApi): Promise<WorkloadLists> {
  const lists = await Promise.all(KINDS.map((k) => listSafe<Workload>(k8s, k.ref)));
  const result: WorkloadLists = { items: [], failures: [] };
  lists.forEach((listed, index) => {
    const { kind, plural } = KINDS[index]!;
    if (listed.ok) {
      for (const workload of listed.items.toSorted(byName)) result.items.push({ kind, workload });
    } else if (!listed.absent) {
      result.failures.push(`${plural} could not be listed: ${listed.error}`);
    }
  });
  return result;
}

export function matchApp(signature: Signature, workloads: WorkloadLists): AppMatches {
  const matches = workloads.items.flatMap(({ kind, workload }) => {
    const match = matchWorkload(workload, kind, signature);
    return match ? [match] : [];
  });
  // Stable sort: kind order, then namespace/name, within each strength.
  const primary = matches.toSorted((a, b) => b.strength - a.strength)[0];
  if (!primary) return { workloads: [] };
  const namespace = primary.workload.metadata.namespace;
  return {
    primary,
    workloads: matches.filter((m) => m.workload.metadata.namespace === namespace).map((m) => m.workload),
  };
}

function detectFromWorkloads(k8s: K8sApi, entry: CatalogEntry, matches: AppMatches, failures: string[]): DetectedApp {
  const { primary } = matches;
  if (!primary) {
    if (failures.length > 0) {
      return {
        appId: entry.id,
        state: "unknown",
        urls: [],
        evidence: failures.join("; "),
        managedBy: null,
        ownedByUs: false,
      };
    }
    return {
      appId: entry.id,
      state: "not-installed",
      urls: [],
      evidence: "No matching Deployment, StatefulSet or DaemonSet",
      managedBy: null,
      ownedByUs: false,
    };
  }
  const { workload } = primary;
  const labels = workload.metadata.labels ?? {};
  const managedBy = k8s.managedBy(workload);
  const release =
    workload.metadata.annotations?.["meta.helm.sh/release-name"] ??
    (labels["app.kubernetes.io/managed-by"] === "Helm" ? labels["app.kubernetes.io/instance"] : undefined);
  const chart = chartVersion(labels["helm.sh/chart"]);
  return {
    appId: entry.id,
    state: "installed",
    ...(workload.metadata.namespace ? { namespace: workload.metadata.namespace } : {}),
    ...(release ? { release } : {}),
    ...(primary.version ? { version: primary.version } : {}),
    ...(chart ? { chartVersion: chart } : {}),
    urls: [],
    evidence: `${primary.kind} ${qualified(workload)} (${primary.reason})`,
    managedBy,
    ownedByUs: matches.workloads.some((w) => ours(k8s, w)),
  };
}

// Our deploy runner's label, or the owner marker on objects the product
// created directly.
const ours = (k8s: K8sApi, obj: KubeObject) => isDeployedByUs(obj) || k8s.isOwned(obj);

// Longhorn's backup target is a setting, not a workload: it is "installed"
// once the default BackupTarget has a URL.
async function detectBackupTarget(k8s: K8sApi, entry: CatalogEntry): Promise<DetectedApp> {
  const base = { appId: entry.id, urls: [], managedBy: null, ownedByUs: false };
  const listed = await listSafe<BackupTarget>(k8s, RESOURCES.longhornBackupTargets);
  if (!listed.ok) {
    return listed.absent
      ? { ...base, state: "not-installed", evidence: "Longhorn is not installed (longhorn.io not served)" }
      : { ...base, state: "unknown", evidence: `BackupTargets could not be listed: ${listed.error}` };
  }
  const target =
    listed.items.find((t) => t.metadata.name === "default" && t.spec?.backupTargetURL) ??
    listed.items.find((t) => t.spec?.backupTargetURL);
  if (!target) {
    return { ...base, state: "not-installed", evidence: "No Longhorn BackupTarget has a URL set" };
  }
  return {
    ...base,
    state: "installed",
    ...(target.metadata.namespace ? { namespace: target.metadata.namespace } : {}),
    evidence: `BackupTarget ${qualified(target)} (${redactUrl(target.spec!.backupTargetURL!)})`,
    managedBy: k8s.managedBy(target),
    ownedByUs: ours(k8s, target),
  };
}

// The shared Postgres is a CloudNativePG Cluster, not a workload: it is
// "installed" once the Cluster the apps use exists. version: its image tag.
async function detectSharedPostgres(k8s: K8sApi, entry: CatalogEntry): Promise<DetectedApp> {
  const base = { appId: entry.id, urls: [], managedBy: null, ownedByUs: false };
  const listed = await listSafe<KubeObject & { spec?: { imageName?: string } }>(k8s, RESOURCES.cnpgClusters);
  if (!listed.ok) {
    return listed.absent
      ? { ...base, state: "not-installed", evidence: "CloudNativePG is not installed (postgresql.cnpg.io not served)" }
      : { ...base, state: "unknown", evidence: `Postgres clusters could not be listed: ${listed.error}` };
  }
  const label = pgClusterLabel(product.ownerMarker.labelDomain);
  const cluster =
    listed.items.find((c) => c.metadata.labels?.[label] === "current") ??
    listed.items.find(
      (c) => c.metadata.namespace === POSTGRES_NAMESPACE && c.metadata.name === pgClusterName(product.slug)
    );
  if (!cluster) {
    return { ...base, state: "not-installed", evidence: `No shared Postgres cluster in ${POSTGRES_NAMESPACE}` };
  }
  const tag = /:([^:@/]+)(@.*)?$/.exec(cluster.spec?.imageName ?? "")?.[1];
  return {
    ...base,
    state: "installed",
    ...(cluster.metadata.namespace ? { namespace: cluster.metadata.namespace } : {}),
    ...(tag ? { version: tag } : {}),
    evidence: `Cluster ${qualified(cluster)} (postgresql.cnpg.io)`,
    managedBy: k8s.managedBy(cluster),
    ownedByUs: ours(k8s, cluster),
  };
}

// s3://key:secret@bucket/ never leaves the server with its credentials.
function redactUrl(url: string): string {
  return url.replace(/\/\/[^/@]*@/, "//***@");
}

// --- ingress hosts -------------------------------------------------------

function selects(selector: Record<string, string> | undefined, workload: Workload): boolean {
  if (!selector || Object.keys(selector).length === 0) return false;
  const labels = workload.spec?.template?.metadata?.labels ?? {};
  return Object.entries(selector).every(([key, value]) => labels[key] === value);
}

// The backend as the cluster reaches it, when its port resolves to a number.
export function serviceUrl(backend: Backend | undefined, namespace: string, service: Service | undefined) {
  const name = backend?.service?.name;
  if (!name) return undefined;
  const wanted = backend.service?.port;
  const port =
    wanted?.number ??
    (wanted?.name ? service?.spec?.ports?.find((p) => p.name === wanted.name)?.port : undefined) ??
    (wanted ? undefined : service?.spec?.ports?.length === 1 ? service.spec.ports[0]!.port : undefined);
  if (!port) return undefined;
  const https = port === 443 || wanted?.name === "https";
  return `${https ? "https" : "http"}://${name}.${namespace}.svc:${port}`;
}

const lbAddress = (status: LoadBalancerStatus | undefined) => {
  const first = status?.loadBalancer?.ingress?.[0];
  return first?.ip ?? first?.hostname;
};

function ingressHosts(
  ingresses: Ingress[],
  services: Service[],
  apps: Array<{ entry: CatalogEntry; matches: AppMatches }>
): IngressHost[] {
  const serviceAt = new Map(services.map((s) => [`${s.metadata.namespace}/${s.metadata.name}`, s]));
  const hosts = new Map<string, IngressHost>();

  for (const ingress of ingresses.toSorted(byName)) {
    const namespace = ingress.metadata.namespace ?? "";
    const ingressClass =
      ingress.spec?.ingressClassName ?? ingress.metadata.annotations?.[INGRESS_CLASS_ANNOTATION] ?? undefined;
    const middlewares = (ingress.metadata.annotations?.[MIDDLEWARES_ANNOTATION] ?? "")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    const rules: Array<{ host: string; backend?: Backend; tls: boolean }> = [];
    if (ingressClass === TAILSCALE_CLASS) {
      const host = ingress.status?.loadBalancer?.ingress?.find((i) => i.hostname)?.hostname;
      const backend =
        ingress.spec?.defaultBackend ??
        ingress.spec?.rules?.flatMap((r) => r.http?.paths ?? []).find((p) => p.backend?.service?.name)?.backend;
      if (host) rules.push({ host, backend, tls: true });
    } else {
      for (const rule of ingress.spec?.rules ?? []) {
        const host = rule.host;
        if (!host || host.includes("*")) continue;
        rules.push({
          host,
          backend: rule.http?.paths?.find((p) => p.backend?.service?.name)?.backend ?? ingress.spec?.defaultBackend,
          tls: (ingress.spec?.tls ?? []).some((t) => t.hosts?.includes(host)),
        });
      }
    }

    for (const { host, backend, tls } of rules) {
      const serviceName = backend?.service?.name;
      const service = serviceName ? serviceAt.get(`${namespace}/${serviceName}`) : undefined;

      let appId = apps.find(({ matches }) =>
        matches.workloads.some((w) => w.metadata.namespace === namespace && selects(service?.spec?.selector, w))
      )?.entry.id;
      // An auth proxy in front of the app breaks the selector link. Accept
      // the app that lives in this namespace when the host or Ingress is
      // named after it.
      if (!appId) {
        const first = host.split(".")[0] ?? "";
        appId = apps.find(
          ({ entry, matches }) =>
            matches.primary?.workload.metadata.namespace === namespace &&
            [entry.id, ...signatures[entry.id]!.names].some(
              (name) => first === name || ingress.metadata.name === name || ingress.metadata.name.startsWith(`${name}-`)
            )
        )?.entry.id;
      }

      const url = serviceUrl(backend, namespace, service);
      const view: IngressHost = {
        host,
        url: `${tls ? "https" : "http"}://${host}`,
        tls,
        namespace,
        ingress: ingress.metadata.name,
        ...(serviceName ? { service: serviceName } : {}),
        ...(url ? { serviceUrl: url } : {}),
        ...(ingressClass ? { ingressClass } : {}),
        ...(appId ? { appId } : {}),
        ...(middlewares.length > 0 ? { middlewares } : {}),
      };
      const existing = hosts.get(host);
      // One entry per host; an HTTPS one wins over a plain one.
      if (!existing || (tls && !existing.tls)) hosts.set(host, view);
    }
  }
  return [...hosts.values()].toSorted((a, b) => a.host.localeCompare(b.host));
}

// The ingress controller's front door: a LoadBalancer Service serving port
// 80, preferring one named after the default ingress class (k3s's
// kube-system/traefik). Its in-cluster URL is a tunnel's origin; its
// address is what DNS records and hosts files point at. Falls back to the
// address any Ingress reports.
export function ingressFrontDoor(
  services: Service[],
  ingresses: Ingress[],
  ingressClass: string | undefined
): { ingressService?: string; ingressAddress?: string } {
  const candidates = services
    .filter((s) => s.spec?.type === "LoadBalancer" && s.spec.ports?.some((p) => p.port === 80))
    .toSorted(byName);
  const named = (s: Service) => Boolean(ingressClass && s.metadata.name.includes(ingressClass));
  const door = candidates.find(named) ?? candidates[0];
  const address =
    lbAddress(door?.status) ??
    ingresses
      .filter((i) => (i.spec?.ingressClassName ?? "") !== TAILSCALE_CLASS)
      .map((i) => lbAddress(i.status))
      .find(Boolean);
  return {
    ...(door ? { ingressService: `http://${door.metadata.name}.${door.metadata.namespace}.svc.cluster.local:80` } : {}),
    ...(address ? { ingressAddress: address } : {}),
  };
}

// The parent domain most hosts share: "grafana.home.example.com" counts
// for "home.example.com". Ties go to the alphabetically first.
export function baseDomain(hosts: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const host of hosts) {
    const labels = host.split(".");
    if (labels.length < 3) continue;
    const parent = labels.slice(1).join(".");
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return [...counts.entries()].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

// --- basics --------------------------------------------------------------

const isTrue = (value: string | undefined) => value === "true";
const ready = (obj: Readiness) => {
  const condition = obj.status?.conditions?.find((c) => c.type === "Ready");
  return condition ? condition.status === "True" : true;
};

function storageBasic(listed: Listed<KubeObject>): { basic: ClusterBasic; suggested?: string } {
  const label = "Default storage class";
  const id = "default-storage-class";
  if (!listed.ok) {
    return {
      basic: {
        id,
        label,
        status: "unknown",
        detail: listed.absent ? "storage.k8s.io is not served" : `StorageClasses could not be listed: ${listed.error}`,
        found: [],
        fixAppIds: [],
      },
    };
  }
  const all = listed.items.map((sc) => sc.metadata.name).toSorted();
  const defaults = listed.items
    .filter((sc) => isTrue(sc.metadata.annotations?.[DEFAULT_SC]) || isTrue(sc.metadata.annotations?.[DEFAULT_SC_BETA]))
    .map((sc) => sc.metadata.name)
    .toSorted();
  if (defaults.length === 1) {
    return {
      basic: { id, label, status: "ok", detail: `${defaults[0]} is the default`, found: defaults, fixAppIds: [] },
      suggested: defaults[0],
    };
  }
  if (defaults.length > 1) {
    // Replicated storage beats node-local when both claim to be default.
    const suggested = defaults.find((name) => name === "longhorn") ?? defaults[0];
    return {
      basic: {
        id,
        label,
        status: "warn",
        detail: `${defaults.length} storage classes are marked default (${defaults.join(", ")}); new volumes pick one at random`,
        found: defaults,
        fixAppIds: [],
      },
      suggested,
    };
  }
  return {
    basic: {
      id,
      label,
      status: "crit",
      detail:
        all.length === 0
          ? "No storage class: volumes that apps ask for stay Pending"
          : `No storage class is marked default (have: ${all.join(", ")}); volumes that name none stay Pending`,
      found: [],
      fixAppIds: ["local-path-provisioner", "longhorn"],
    },
    ...(all.length === 1 ? { suggested: all[0] } : {}),
  };
}

function ingressBasic(listed: Listed<KubeObject>): { basic: ClusterBasic; suggested?: string } {
  const label = "Ingress controller";
  const id = "ingress-controller";
  if (!listed.ok) {
    return {
      basic: {
        id,
        label,
        status: "unknown",
        detail: listed.absent
          ? "networking.k8s.io is not served"
          : `IngressClasses could not be listed: ${listed.error}`,
        found: [],
        fixAppIds: [],
      },
    };
  }
  const names = listed.items.map((ic) => ic.metadata.name).toSorted();
  const defaults = listed.items
    .filter((ic) => isTrue(ic.metadata.annotations?.[DEFAULT_IC]))
    .map((ic) => ic.metadata.name);
  if (names.length === 0) {
    return {
      basic: {
        id,
        label,
        status: "crit",
        detail: "No IngressClass: nothing routes web traffic into the cluster",
        found: [],
        fixAppIds: ["traefik"],
      },
    };
  }
  if (defaults.length === 0) {
    return {
      basic: {
        id,
        label,
        status: "warn",
        detail: `IngressClass ${names.join(", ")} found, none marked default: Ingresses must name one`,
        found: names,
        fixAppIds: [],
      },
      suggested: names[0],
    };
  }
  return {
    basic: {
      id,
      label,
      status: "ok",
      detail: names.map((n) => `IngressClass ${n}${defaults.includes(n) ? " (default)" : ""}`).join(", "),
      found: names,
      fixAppIds: [],
    },
    suggested: defaults.toSorted()[0],
  };
}

function certManagerBasic(
  listed: Listed<Readiness>,
  version: string | undefined
): { basic: ClusterBasic; suggested?: string } {
  const label = "cert-manager";
  const id = "cert-manager";
  if (!listed.ok && listed.absent) {
    return {
      basic: {
        id,
        label,
        status: "crit",
        detail: "cert-manager.io is not served: HTTPS certificates must be made by hand",
        found: [],
        fixAppIds: ["cert-manager"],
      },
    };
  }
  const what = version ? `cert-manager ${version}` : "cert-manager";
  if (!listed.ok) {
    return {
      basic: {
        id,
        label,
        status: "unknown",
        detail: `${what} is installed; ClusterIssuers could not be listed: ${listed.error}`,
        found: [],
        fixAppIds: [],
      },
    };
  }
  const names = listed.items.map((i) => i.metadata.name).toSorted();
  const readyNames = listed.items
    .filter(ready)
    .map((i) => i.metadata.name)
    .toSorted();
  if (names.length === 0) {
    return {
      basic: {
        id,
        label,
        status: "warn",
        detail: `${what} has no ClusterIssuer: certificates have nobody to issue them`,
        found: [],
        fixAppIds: ["cert-manager"],
      },
    };
  }
  const suggested = readyNames.find((n) => n.includes("prod")) ?? readyNames[0] ?? names[0];
  if (readyNames.length === 0) {
    return {
      basic: {
        id,
        label,
        status: "warn",
        detail: `${what}: no ClusterIssuer is Ready (${names.join(", ")})`,
        found: names,
        fixAppIds: [],
      },
      suggested,
    };
  }
  const plural = readyNames.length > 1 ? "ClusterIssuers" : "ClusterIssuer";
  return {
    basic: {
      id,
      label,
      status: "ok",
      detail: `${what} with ${plural} ${readyNames.join(", ")}`,
      found: names,
      fixAppIds: [],
    },
    suggested,
  };
}

function metricsBasic(listed: Listed<KubeObject>, version: string | undefined): ClusterBasic {
  const label = "metrics-server";
  const id = "metrics-server";
  if (!listed.ok && listed.absent) {
    return {
      id,
      label,
      status: "crit",
      detail: "metrics.k8s.io is not served: live CPU and memory need metrics-server",
      found: [],
      fixAppIds: ["metrics-server"],
    };
  }
  const what = version ? `metrics.k8s.io is served (metrics-server ${version})` : "metrics.k8s.io is served";
  return {
    id,
    label,
    status: "ok",
    detail: listed.ok ? what : `${what}; node metrics could not be read: ${listed.error}`,
    found: [],
    fixAppIds: [],
  };
}

// --- report --------------------------------------------------------------

export async function discover(
  k8s: K8sApi,
  entries: readonly CatalogEntry[],
  now: () => Date = () => new Date(),
  // From the deploy module: catches charts that drop the deployed-by label.
  releases: readonly DeployedRelease[] = []
): Promise<DiscoveryReport> {
  const [
    kubernetesVersion,
    workloads,
    ingresses,
    services,
    storageClasses,
    ingressClasses,
    issuers,
    nodeMetrics,
    disks,
  ] = await Promise.all([
    k8s.version().then(
      (v) => v.gitVersion,
      () => undefined
    ),
    listWorkloads(k8s),
    listSafe<Ingress>(k8s, RESOURCES.ingresses),
    listSafe<Service>(k8s, RESOURCES.services),
    listSafe<KubeObject>(k8s, RESOURCES.storageClasses),
    listSafe<KubeObject>(k8s, RESOURCES.ingressClasses),
    listSafe<Readiness>(k8s, RESOURCES.clusterIssuers),
    listSafe<KubeObject>(k8s, RESOURCES.nodeMetrics),
    nodeDisks(k8s),
  ]);

  const matched = entries
    .filter((entry) => signatures[entry.id])
    .map((entry) => ({ entry, matches: matchApp(signatures[entry.id]!, workloads) }));
  const hosts = ingressHosts(itemsOf(ingresses), itemsOf(services), matched);

  const apps = await Promise.all(
    entries.map(async (entry): Promise<DetectedApp> => {
      const found = matched.find((m) => m.entry.id === entry.id);
      if (!found) {
        if (entry.install.kind === "patch" && entry.id === "longhorn-backup-target") {
          return detectBackupTarget(k8s, entry);
        }
        if (entry.id === POSTGRES_APP) return detectSharedPostgres(k8s, entry);
        return {
          appId: entry.id,
          state: "unknown",
          urls: [],
          evidence: "No detection signature for this app",
          managedBy: null,
          ownedByUs: false,
        };
      }
      const detected = detectFromWorkloads(k8s, entry, found.matches, workloads.failures);
      detected.urls = hosts
        .filter((h) => h.appId === entry.id)
        .toSorted((a, b) => Number(b.tls) - Number(a.tls))
        .map((h) => h.url);
      return detected;
    })
  );

  for (const app of apps) {
    if (app.state !== "installed" || app.ownedByUs) continue;
    app.ownedByUs = releases.some((r) => r.appId === app.appId && (!app.namespace || r.namespace === app.namespace));
  }

  const versionOf = (id: string) => apps.find((a) => a.appId === id && a.state === "installed")?.version;
  const storage = storageBasic(storageClasses);
  const ingress = ingressBasic(ingressClasses);
  const certs = certManagerBasic(issuers, versionOf("cert-manager"));
  // Tailnet names (*.ts.net) say nothing about the domain apps should use.
  const domain = baseDomain(hosts.filter((h) => h.ingressClass !== TAILSCALE_CLASS).map((h) => h.host));
  const door = ingressFrontDoor(itemsOf(services), itemsOf(ingresses), ingress.suggested);

  return {
    checkedAt: now().toISOString(),
    ...(kubernetesVersion ? { kubernetesVersion } : {}),
    apps,
    ingressHosts: hosts,
    basics: [storage.basic, ingress.basic, certs.basic, metricsBasic(nodeMetrics, versionOf("metrics-server"))],
    ...(disks ? { nodeDisks: disks } : {}),
    suggested: {
      ...(storage.suggested ? { storageClass: storage.suggested } : {}),
      ...(ingress.suggested ? { ingressClass: ingress.suggested } : {}),
      ...(certs.suggested ? { clusterIssuer: certs.suggested } : {}),
      ...(domain ? { baseDomain: domain } : {}),
      ...door,
    },
  };
}

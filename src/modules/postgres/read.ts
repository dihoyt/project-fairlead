import { RESOURCES, type K8sApi, type KubeObject } from "../../contracts/k8s.js";
import {
  POSTGRES_NAMESPACE,
  pgAppLabel,
  pgClusterLabel,
  pgClusterName,
  pgSecretAnnotation,
  type PostgresClusterView,
  type PostgresDatabaseView,
  type PostgresInstanceView,
  type PostgresState,
} from "../../contracts/postgres.js";
import { product } from "../../product.js";

// What the module reads of CloudNativePG's objects, narrowed.

export interface Condition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface CnpgCluster extends KubeObject {
  spec?: {
    instances?: number;
    imageName?: string;
    storage?: { size?: string; storageClass?: string };
    plugins?: Array<{ name?: string; isWALArchiver?: boolean; parameters?: Record<string, string> }>;
  };
  status?: {
    phase?: string;
    phaseReason?: string;
    instances?: number;
    readyInstances?: number;
    currentPrimary?: string;
    image?: string;
    conditions?: Condition[];
  };
}

export interface CnpgDatabase extends KubeObject {
  spec?: { cluster?: { name?: string }; name?: string; owner?: string };
  status?: { applied?: boolean; message?: string };
}

export interface CnpgRole extends KubeObject {
  spec?: { cluster?: { name?: string }; name?: string };
  status?: { applied?: boolean; message?: string };
}

export interface Pod extends KubeObject {
  spec?: { nodeName?: string };
  status?: { podIP?: string; conditions?: Condition[] };
}

export const HIBERNATION = "cnpg.io/hibernation";
const CLUSTER_LABEL = pgClusterLabel(product.ownerMarker.labelDomain);
const APP_LABEL = pgAppLabel(product.ownerMarker.labelDomain);
const SECRET_ANNOTATION = pgSecretAnnotation(product.ownerMarker.labelDomain);
const HEALTHY = "Cluster in healthy state";

export interface Snapshot {
  // CloudNativePG's CRDs are not served.
  absent: boolean;
  barmanCloud: boolean;
  clusters: CnpgCluster[];
  current?: CnpgCluster;
  databases: CnpgDatabase[];
  roles: CnpgRole[];
  pods: Pod[];
}

const items = <T>(listed: T[] | "absent") => (listed === "absent" ? [] : listed);

export async function readSnapshot(k8s: K8sApi): Promise<Snapshot> {
  const namespace = POSTGRES_NAMESPACE;
  const [clusters, databases, roles, stores] = await Promise.all([
    k8s.list<CnpgCluster>(RESOURCES.cnpgClusters, { namespace }),
    k8s.list<CnpgDatabase>(RESOURCES.cnpgDatabases, { namespace }),
    k8s.list<CnpgRole>(RESOURCES.cnpgDatabaseRoles, { namespace }),
    k8s.list(RESOURCES.barmanObjectStores, { namespace }),
  ]);
  if (clusters === "absent") {
    return { absent: true, barmanCloud: stores !== "absent", clusters: [], databases: [], roles: [], pods: [] };
  }
  const current =
    clusters.find((c) => c.metadata.labels?.[CLUSTER_LABEL] === "current") ??
    clusters.find((c) => c.metadata.name === pgClusterName(product.slug));
  const pods = current
    ? await k8s.list<Pod>(RESOURCES.pods, { namespace, labelSelector: `cnpg.io/cluster=${current.metadata.name}` })
    : [];
  return {
    absent: false,
    barmanCloud: stores !== "absent",
    clusters,
    ...(current ? { current } : {}),
    databases: items(databases),
    roles: items(roles),
    pods: items(pods),
  };
}

const ready = (pod: Pod) => pod.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false;

// "ghcr.io/cloudnative-pg/postgresql:17.6-standard-trixie" -> "17.6".
export function versionOf(image: string | undefined): string | undefined {
  return /:(\d+(?:\.\d+)?)/.exec(image ?? "")?.[1];
}

function stateOf(cluster: CnpgCluster): PostgresState {
  const wanted = cluster.spec?.instances ?? 1;
  const readyCount = cluster.status?.readyInstances ?? 0;
  const phase = cluster.status?.phase ?? "";
  if (readyCount >= wanted && (!phase || phase === HEALTHY)) return "ready";
  // The operator's phases while a new cluster comes up.
  if (readyCount === 0 && (!phase || /setting up|creating|initiali[sz]|bootstrap/i.test(phase))) return "starting";
  return "degraded";
}

export function clusterView(snapshot: Snapshot, at: string): PostgresClusterView {
  const base = {
    operator: snapshot.absent ? ("absent" as const) : ("installed" as const),
    barmanCloud: snapshot.barmanCloud ? ("installed" as const) : ("absent" as const),
    namespace: POSTGRES_NAMESPACE,
    checkedAt: at,
  };
  const previous = snapshot.clusters
    .filter((c) => c !== snapshot.current && c.metadata.labels?.[CLUSTER_LABEL] === "previous")
    .toSorted((a, b) => (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? ""))
    .map((c) => ({
      name: c.metadata.name,
      hibernated: c.metadata.annotations?.[HIBERNATION] === "on",
      ...(c.metadata.creationTimestamp ? { createdAt: c.metadata.creationTimestamp } : {}),
    }));
  const cluster = snapshot.current;
  if (!cluster) {
    return { ...base, state: "absent", instances: 0, readyInstances: 0, instanceList: [], previous };
  }
  const instanceList: PostgresInstanceView[] = snapshot.pods
    .map((pod) => ({
      pod: pod.metadata.name,
      ...(pod.spec?.nodeName ? { node: pod.spec.nodeName } : {}),
      role: pod.metadata.name === cluster.status?.currentPrimary ? ("primary" as const) : ("replica" as const),
      ready: ready(pod),
    }))
    .toSorted((a, b) => a.pod.localeCompare(b.pod));
  const version = versionOf(cluster.status?.image ?? cluster.spec?.imageName);
  return {
    ...base,
    state: stateOf(cluster),
    name: cluster.metadata.name,
    ...(cluster.status?.phase ? { phase: cluster.status.phase } : {}),
    ...(cluster.status?.phaseReason ? { message: cluster.status.phaseReason } : {}),
    ...(version ? { version } : {}),
    instances: cluster.spec?.instances ?? 1,
    readyInstances: cluster.status?.readyInstances ?? 0,
    instanceList,
    ...(cluster.spec?.storage?.storageClass ? { storageClass: cluster.spec.storage.storageClass } : {}),
    ...(cluster.spec?.storage?.size ? { size: cluster.spec.storage.size } : {}),
    previous,
  };
}

export interface DatabaseStats {
  sizeBytes: Map<string, number>;
  connections: Map<string, number>;
}

export function databaseViews(snapshot: Snapshot, stats?: DatabaseStats): PostgresDatabaseView[] {
  const cluster = snapshot.current?.metadata.name;
  if (!cluster) return [];
  const ofCluster = <T extends CnpgDatabase | CnpgRole>(list: T[]) =>
    list.filter((o) => o.spec?.cluster?.name === cluster);
  const roles = ofCluster(snapshot.roles);
  return ofCluster(snapshot.databases)
    .filter((db) => db.spec?.name)
    .map((db): PostgresDatabaseView => {
      const name = db.spec!.name!;
      const owner = db.spec?.owner ?? name;
      const role = roles.find((r) => r.spec?.name === owner);
      const appId = db.metadata.labels?.[APP_LABEL];
      const [secretNamespace, secretName] = (db.metadata.annotations?.[SECRET_ANNOTATION] ?? "").split("/");
      // A role the operator manages must be applied too; one it doesn't know is someone else's.
      const applied = (db.status?.applied ?? false) && (role ? (role.status?.applied ?? false) : true);
      const message = !applied ? (db.status?.message ?? role?.status?.message) : undefined;
      const size = stats?.sizeBytes.get(name);
      const connections = stats?.connections.get(name);
      return {
        database: name,
        role: owner,
        ...(appId ? { appId } : {}),
        ...(secretNamespace && secretName ? { secret: { namespace: secretNamespace, name: secretName } } : {}),
        applied,
        ...(message ? { message } : {}),
        ...(size !== undefined ? { sizeBytes: size } : {}),
        ...(connections !== undefined ? { connections } : {}),
      };
    })
    .toSorted((a, b) => a.database.localeCompare(b.database));
}

export const primaryPod = (snapshot: Snapshot) =>
  snapshot.pods.find((p) => p.metadata.name === snapshot.current?.status?.currentPrimary);

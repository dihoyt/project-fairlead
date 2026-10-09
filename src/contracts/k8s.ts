// The Kubernetes service module "k8s" (A1) provides through
// ctx.services.provide("k8s", …). Every other module reaches the cluster
// through this interface only.

export type Absent = "absent";

export interface ResourceRef {
  // "" for the core group.
  group: string;
  version: string;
  plural: string;
  kind: string;
  namespaced: boolean;
}

function ref(group: string, version: string, plural: string, kind: string, namespaced: boolean): ResourceRef {
  return { group, version, plural, kind, namespaced };
}

// Everything Milestone A reads. The chart's read-only ClusterRole (S4)
// grants exactly these, plus nodes/proxy and pods/log.
export const RESOURCES = {
  namespaces: ref("", "v1", "namespaces", "Namespace", false),
  nodes: ref("", "v1", "nodes", "Node", false),
  pods: ref("", "v1", "pods", "Pod", true),
  events: ref("", "v1", "events", "Event", true),
  pvcs: ref("", "v1", "persistentvolumeclaims", "PersistentVolumeClaim", true),
  pvs: ref("", "v1", "persistentvolumes", "PersistentVolume", false),
  secrets: ref("", "v1", "secrets", "Secret", true),
  storageClasses: ref("storage.k8s.io", "v1", "storageclasses", "StorageClass", false),
  deployments: ref("apps", "v1", "deployments", "Deployment", true),
  statefulSets: ref("apps", "v1", "statefulsets", "StatefulSet", true),
  daemonSets: ref("apps", "v1", "daemonsets", "DaemonSet", true),
  replicaSets: ref("apps", "v1", "replicasets", "ReplicaSet", true),
  jobs: ref("batch", "v1", "jobs", "Job", true),
  cronJobs: ref("batch", "v1", "cronjobs", "CronJob", true),
  podMetrics: ref("metrics.k8s.io", "v1beta1", "pods", "PodMetrics", true),
  nodeMetrics: ref("metrics.k8s.io", "v1beta1", "nodes", "NodeMetrics", false),
  longhornVolumes: ref("longhorn.io", "v1beta2", "volumes", "Volume", true),
  longhornBackups: ref("longhorn.io", "v1beta2", "backups", "Backup", true),
  longhornBackupVolumes: ref("longhorn.io", "v1beta2", "backupvolumes", "BackupVolume", true),
  longhornBackupTargets: ref("longhorn.io", "v1beta2", "backuptargets", "BackupTarget", true),
  longhornRecurringJobs: ref("longhorn.io", "v1beta2", "recurringjobs", "RecurringJob", true),
  longhornSettings: ref("longhorn.io", "v1beta2", "settings", "Setting", true),
  longhornNodes: ref("longhorn.io", "v1beta2", "nodes", "Node", true),
  longhornReplicas: ref("longhorn.io", "v1beta2", "replicas", "Replica", true),
  longhornSnapshots: ref("longhorn.io", "v1beta2", "snapshots", "Snapshot", true),
  veleroBackups: ref("velero.io", "v1", "backups", "Backup", true),
  veleroSchedules: ref("velero.io", "v1", "schedules", "Schedule", true),
  veleroRestores: ref("velero.io", "v1", "restores", "Restore", true),
  veleroBackupStorageLocations: ref("velero.io", "v1", "backupstoragelocations", "BackupStorageLocation", true),
  fleetGitRepos: ref("fleet.cattle.io", "v1alpha1", "gitrepos", "GitRepo", true),
  fleetBundles: ref("fleet.cattle.io", "v1alpha1", "bundles", "Bundle", true),
  certificates: ref("cert-manager.io", "v1", "certificates", "Certificate", true),
  // Discovery (catalog module): what is installed and where it is reachable.
  ingresses: ref("networking.k8s.io", "v1", "ingresses", "Ingress", true),
  ingressClasses: ref("networking.k8s.io", "v1", "ingressclasses", "IngressClass", false),
  services: ref("", "v1", "services", "Service", true),
  clusterIssuers: ref("cert-manager.io", "v1", "clusterissuers", "ClusterIssuer", false),
} as const satisfies Record<string, ResourceRef>;

export type ResourceName = keyof typeof RESOURCES;

export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: Array<{ apiVersion: string; kind: string; name: string; uid: string; controller?: boolean }>;
}

// Objects come back as the API server sends them; providers narrow the
// fields they read. client-node's typed models are fine to use inside a
// module, but nothing crosses a module boundary as one.
export interface KubeObject {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  spec?: unknown;
  status?: unknown;
  [field: string]: unknown;
}

export interface ListOptions {
  // Omitted for a namespaced resource: all namespaces.
  namespace?: string;
  labelSelector?: string;
  fieldSelector?: string;
}

export interface WatchHandlers<T extends KubeObject> {
  add?(obj: T): void;
  update?(obj: T, old: T): void;
  delete?(obj: T): void;
  // Watch errors are retried inside the service; this only reports them.
  error?(err: Error): void;
}

export interface Watch<T extends KubeObject> {
  // Resolves after the initial list has been delivered.
  synced: Promise<void>;
  // The informer's cache, current as of the call.
  list(): T[];
  stop(): void;
}

export interface LogOptions {
  container?: string;
  tailLines?: number;
  sinceSeconds?: number;
  follow?: boolean;
  timestamps?: boolean;
  previous?: boolean;
}

export interface LogStream {
  // Settles when the stream ends: pod gone, follow stopped, or not following.
  done: Promise<void>;
  stop(): void;
}

export interface AccessCheck {
  // create and delete: the deploy module checks its own namespaced grants.
  verb: "get" | "list" | "watch" | "create" | "delete";
  group: string;
  resource: string;
  subresource?: string;
  namespace?: string;
}

export interface Capability {
  // "longhorn.volumes", "core.nodes/proxy".
  id: string;
  label: string;
  check: AccessCheck;
  allowed: boolean;
  // Present when the API group exists in the cluster at all.
  groupPresent: boolean;
  // What to grant or install, shown in place of the feature: "needs get on nodes/proxy".
  needs?: string;
  // A grant the chart withholds unless enabled (Secret reads:
  // rbac.secrets.enabled); denied then means off, not a problem.
  optIn?: boolean;
}

export interface CapabilityReport {
  checkedAt: string;
  capabilities: Capability[];
}

export type ManagedBy = "fleet" | "helm" | "argo";

export interface K8sVersion {
  major: string;
  minor: string;
  gitVersion: string;
  platform?: string;
}

export interface K8sServerInfo {
  // The API server URL from the kubeconfig or in-cluster config.
  url: string;
  host: string;
  // Absent for a plain-http server or when no certificate could be read.
  certificate?: {
    subject: string;
    issuer: string;
    // ISO 8601.
    notAfter: string;
  };
}

export interface K8sApi {
  // "absent" when the resource's API group is not served by this cluster
  // (CRD not installed), never an error.
  list<T extends KubeObject = KubeObject>(ref: ResourceRef, options?: ListOptions): Promise<T[] | Absent>;
  get<T extends KubeObject = KubeObject>(
    ref: ResourceRef,
    name: string,
    namespace?: string
  ): Promise<T | null | Absent>;
  watch<T extends KubeObject = KubeObject>(
    ref: ResourceRef,
    options?: ListOptions,
    handlers?: WatchHandlers<T>
  ): Promise<Watch<T> | Absent>;
  // GET against the API server, parsed JSON. For subresources with no
  // typed call, e.g. /api/v1/nodes/<node>/proxy/stats/summary.
  raw(path: string): Promise<unknown>;
  logs(namespace: string, pod: string, options: LogOptions, onLine: (line: string) => void): Promise<LogStream>;
  version(): Promise<K8sVersion>;
  // Where the API server is and the certificate it serves, read from a fresh
  // TLS handshake. Optional until the k8s module implements it: callers
  // treat a missing method as "unknown", not as a failure.
  serverInfo?(): Promise<K8sServerInfo>;
  // Writes, used only by the deploy module for its Jobs and their values
  // Secrets in this product's own namespace, and by onboarding to delete the
  // install seed Secret (./onboarding.ts); the chart grants nothing wider to
  // the product's ServiceAccount. create labels the object with
  // ownedLabels() before sending it. Optional until the k8s module
  // implements them: the deploy module reports deploys as unavailable.
  create?<T extends KubeObject = KubeObject>(ref: ResourceRef, obj: T): Promise<T>;
  // Foreground propagation, so a Job's pods go with it. A missing object is
  // not an error.
  delete?(ref: ResourceRef, name: string, namespace?: string): Promise<void>;
  // Cached; refreshed on an interval and on demand.
  capabilities(refresh?: boolean): Promise<CapabilityReport>;
  can(check: AccessCheck): Promise<boolean>;
  managedBy(obj: KubeObject): ManagedBy | null;
  // { "app.kubernetes.io/managed-by": ownerMarker.labelDomain } from product.json.
  ownedLabels(): Record<string, string>;
  // True when that label carries the current marker's labelDomain or any
  // legacy one's.
  isOwned(obj: KubeObject): boolean;
}

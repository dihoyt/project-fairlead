import type { KubeObject, ManagedBy, ObjectMeta } from "../../contracts/k8s.js";
import type {
  ContainerView,
  EventView,
  NamespaceView,
  PodView,
  WorkloadKind,
  WorkloadView,
} from "../../contracts/workloads.js";

interface ContainerSpec {
  name: string;
  image?: string;
}

interface PodTemplate {
  spec?: { containers?: ContainerSpec[]; initContainers?: ContainerSpec[] };
}

interface ContainerStatus {
  name: string;
  image?: string;
  ready?: boolean;
  restartCount?: number;
  state?: {
    running?: object;
    waiting?: { reason?: string };
    terminated?: { reason?: string; exitCode?: number };
  };
}

export interface Pod extends KubeObject {
  spec?: { nodeName?: string; containers?: ContainerSpec[]; initContainers?: ContainerSpec[] };
  status?: {
    phase?: string;
    reason?: string;
    containerStatuses?: ContainerStatus[];
    initContainerStatuses?: ContainerStatus[];
  };
}

export interface Workload extends KubeObject {
  spec?: {
    replicas?: number;
    completions?: number;
    suspend?: boolean;
    template?: PodTemplate;
    jobTemplate?: { spec?: { template?: PodTemplate } };
  };
  status?: {
    replicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    desiredNumberScheduled?: number;
    numberReady?: number;
    numberAvailable?: number;
    succeeded?: number;
    active?: number | unknown[];
    conditions?: Array<{ type?: string; status?: string }>;
  };
}

export interface KubeEvent extends KubeObject {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  eventTime?: string;
  series?: { count?: number; lastObservedTime?: string };
  involvedObject?: { kind?: string; name?: string; namespace?: string };
}

export const WORKLOAD_KINDS: readonly WorkloadKind[] = ["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"];

export function isWorkloadKind(kind: string): kind is WorkloadKind {
  return (WORKLOAD_KINDS as readonly string[]).includes(kind);
}

const created = (meta: ObjectMeta) => meta.creationTimestamp ?? "";

function controller(meta: ObjectMeta) {
  return meta.ownerReferences?.find((ref) => ref.controller) ?? meta.ownerReferences?.[0];
}

// "Kind/name" of the object's top-level owner, looked up through the
// intermediate controllers kubectl users never think about: a ReplicaSet
// stands for its Deployment and a Job for its CronJob.
export type Intermediates = Map<string, string>;

export function intermediateKey(namespace: string | undefined, kind: string, name: string) {
  return `${namespace ?? ""}/${kind}/${name}`;
}

// ReplicaSets and Jobs, keyed by namespace/kind/name, mapped to their own owner.
export function intermediates(replicaSets: KubeObject[], jobs: KubeObject[]): Intermediates {
  const map: Intermediates = new Map();
  for (const obj of [...replicaSets, ...jobs]) {
    const owner = controller(obj.metadata);
    if (owner) {
      map.set(
        intermediateKey(obj.metadata.namespace, obj.kind ?? "", obj.metadata.name),
        `${owner.kind}/${owner.name}`
      );
    }
  }
  return map;
}

export function topOwner(obj: KubeObject, through: Intermediates): string | undefined {
  const owner = controller(obj.metadata);
  if (!owner) return undefined;
  if (owner.kind === "ReplicaSet" || owner.kind === "Job") {
    const above = through.get(intermediateKey(obj.metadata.namespace, owner.kind, owner.name));
    if (above) return above;
  }
  return `${owner.kind}/${owner.name}`;
}

function containerState(status: ContainerStatus | undefined): Pick<ContainerView, "state" | "reason"> {
  const state = status?.state;
  if (state?.running) return { state: "running" };
  if (state?.waiting) return { state: "waiting", ...(state.waiting.reason ? { reason: state.waiting.reason } : {}) };
  if (state?.terminated) {
    const reason = state.terminated.reason ?? `exit ${state.terminated.exitCode ?? "?"}`;
    return { state: "terminated", reason };
  }
  return { state: "unknown" };
}

export function podView(pod: Pod, through: Intermediates): PodView {
  const specs = pod.spec?.containers ?? [];
  const statuses = new Map((pod.status?.containerStatuses ?? []).map((s) => [s.name, s]));
  const containers: ContainerView[] = specs.map((spec) => {
    const status = statuses.get(spec.name);
    return {
      name: spec.name,
      image: status?.image ?? spec.image ?? "",
      ready: status?.ready ?? false,
      restarts: status?.restartCount ?? 0,
      ...containerState(status),
    };
  });
  const ready = containers.filter((c) => c.ready).length;
  const owner = topOwner(pod, through);
  return {
    namespace: pod.metadata.namespace ?? "",
    name: pod.metadata.name,
    phase: (pod.metadata as { deletionTimestamp?: string }).deletionTimestamp
      ? "Terminating"
      : (pod.status?.phase ?? "Unknown"),
    ready: `${ready}/${containers.length}`,
    restarts: containers.reduce((sum, c) => sum + c.restarts, 0),
    ...(pod.spec?.nodeName ? { node: pod.spec.nodeName } : {}),
    ...(owner ? { owner } : {}),
    containers,
    createdAt: created(pod.metadata),
  };
}

// A pod that has finished its work (a completed Job) is healthy; anything
// else not running with every container ready is not.
export function isUnhealthy(pod: PodView): boolean {
  if (pod.phase === "Succeeded") return false;
  if (pod.phase !== "Running") return true;
  return pod.containers.some((c) => !c.ready);
}

function images(template: PodTemplate | undefined): string[] {
  return [...new Set((template?.spec?.containers ?? []).map((c) => c.image ?? "").filter(Boolean))];
}

function count(value: number | unknown[] | undefined): number {
  return Array.isArray(value) ? value.length : (value ?? 0);
}

export function workloadView(obj: Workload, kind: WorkloadKind, managedBy: ManagedBy | null): WorkloadView {
  const spec = obj.spec ?? {};
  const status = obj.status ?? {};
  let desired: number;
  let available: number;
  let ready: string;
  let template = spec.template;
  let finished: WorkloadView["finished"];
  switch (kind) {
    case "Deployment":
    case "StatefulSet":
      desired = spec.replicas ?? 1;
      available = status.availableReplicas ?? 0;
      ready = `${status.readyReplicas ?? 0}/${desired}`;
      break;
    case "DaemonSet":
      desired = status.desiredNumberScheduled ?? 0;
      available = status.numberAvailable ?? 0;
      ready = `${status.numberReady ?? 0}/${desired}`;
      break;
    case "Job":
      desired = spec.completions ?? 1;
      available = status.succeeded ?? 0;
      ready = `${available}/${desired}`;
      for (const c of status.conditions ?? []) {
        if (c.status !== "True") continue;
        if (c.type === "Complete") finished = "complete";
        else if (c.type === "Failed") finished = "failed";
      }
      break;
    case "CronJob": {
      template = spec.jobTemplate?.spec?.template;
      const active = count(status.active);
      desired = active;
      available = active;
      ready = spec.suspend ? "suspended" : `${active} active`;
      break;
    }
  }
  return {
    namespace: obj.metadata.namespace ?? "",
    name: obj.metadata.name,
    kind,
    ready,
    desired,
    available,
    images: images(template),
    managedBy,
    createdAt: created(obj.metadata),
    ...(finished ? { finished } : {}),
  };
}

export function namespaceView(
  ns: KubeObject,
  workloads: number,
  pods: PodView[],
  managedBy: ManagedBy | null
): NamespaceView {
  return {
    name: ns.metadata.name,
    status: (ns.status as { phase?: string } | undefined)?.phase ?? "Unknown",
    workloads,
    pods: pods.length,
    unhealthyPods: pods.filter(isUnhealthy).length,
    managedBy,
    createdAt: created(ns.metadata),
  };
}

export function eventView(event: KubeEvent): EventView {
  const involved = event.involvedObject ?? {};
  return {
    type: event.type === "Warning" ? "Warning" : "Normal",
    reason: event.reason ?? "",
    message: (event.message ?? "").trim(),
    object: `${involved.kind ?? "Unknown"}/${involved.name ?? ""}`,
    count: event.series?.count ?? event.count ?? 1,
    lastSeen:
      event.series?.lastObservedTime ??
      event.lastTimestamp ??
      event.eventTime ??
      event.firstTimestamp ??
      created(event.metadata),
  };
}

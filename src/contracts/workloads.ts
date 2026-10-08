import type { ManagedBy } from "./k8s.js";

export interface NamespaceView {
  name: string;
  status: string;
  workloads: number;
  pods: number;
  unhealthyPods: number;
  managedBy: ManagedBy | null;
  createdAt: string;
}

export type WorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet" | "Job" | "CronJob";

export interface WorkloadView {
  namespace: string;
  name: string;
  kind: WorkloadKind;
  ready: string;
  desired: number;
  available: number;
  images: string[];
  managedBy: ManagedBy | null;
  createdAt: string;
  // Jobs only: finished, every completion succeeded (Complete condition), or
  // gave up (Failed condition). Absent while it runs. ready counts
  // succeeded pods for a Job.
  finished?: "complete" | "failed";
}

export interface ContainerView {
  name: string;
  image: string;
  ready: boolean;
  restarts: number;
  state: "running" | "waiting" | "terminated" | "unknown";
  reason?: string;
}

export interface PodView {
  namespace: string;
  name: string;
  phase: string;
  ready: string;
  restarts: number;
  node?: string;
  // "Deployment/grafana"; resolved through the ReplicaSet for Deployments.
  owner?: string;
  containers: ContainerView[];
  createdAt: string;
}

export interface EventView {
  type: "Normal" | "Warning";
  reason: string;
  message: string;
  object: string;
  count: number;
  lastSeen: string;
}

export interface LogLines {
  lines: string[];
  // Lines that had a Secret value in them replaced.
  redacted: number;
  truncated: boolean;
}

// Where the same workloads open in the cluster's other UIs, when the install
// has them. Each is absent when not configured; the client builds the deep
// path itself from the url and the cluster's name or id.
export interface WorkloadLinks {
  headlamp?: { url: string; cluster: string };
  rancher?: { url: string; clusterId: string };
}

// --- Usage: actual CPU and memory against requests and limits ------------
// From the container samples the node and container metrics collector
// already stores (container.cpu.percent, container.memory.bytes); no
// Prometheus. Every number is optional: a cluster whose kubelet can't be read
// has no usage, and containers that set no request or limit have none.

export type UsageRange = "1h" | "24h" | "7d";

export interface ResourceUsage {
  // CPU in cores, memory in bytes.
  // The latest collected value, when one is a few minutes old at most.
  current?: number;
  // Mean over the range.
  avg?: number;
  // The highest bucket mean in the range, so a short spike is smoothed by
  // the bucket width (about range / 120).
  peak?: number;
  // Summed over the running containers that set one.
  request?: number;
  // Summed over running containers; absent unless every one sets a limit,
  // since one unlimited container makes the total unlimited.
  limit?: number;
}

export interface UsageView {
  cpu: ResourceUsage;
  memory: ResourceUsage;
  // Sparkline points over the range, [unix ms, value], ascending, summed
  // across the containers below this level. Cores and bytes.
  cpuPoints?: [number, number][];
  memoryPoints?: [number, number][];
}

export interface NamespaceUsage extends UsageView {
  namespace: string;
}

export interface WorkloadUsage extends UsageView {
  kind: WorkloadKind;
  name: string;
  pods: number;
}

export interface ContainerUsage extends Omit<UsageView, "cpuPoints" | "memoryPoints"> {
  name: string;
}

export interface PodUsage extends UsageView {
  name: string;
  // As PodView.owner: "Deployment/grafana".
  owner?: string;
  containers: ContainerUsage[];
}

interface UsageReport {
  range: UsageRange;
  // Unix ms.
  from: number;
  to: number;
  // False when no container samples exist in the range at all (the metrics
  // collector can't read the kubelet or metrics-server): the client says so
  // instead of showing zeros. Requests and limits are still filled in.
  collected: boolean;
}

export interface ClusterUsageReport extends UsageReport {
  // One per namespace that has pods or samples in the range.
  namespaces: NamespaceUsage[];
}

export interface SpaceUsageReport extends UsageReport {
  // Pods a CronJob's Jobs ran count toward the CronJob.
  workloads: WorkloadUsage[];
  // Current pods only; a pod gone before `to` is in its workload's total.
  pods: PodUsage[];
}

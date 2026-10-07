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

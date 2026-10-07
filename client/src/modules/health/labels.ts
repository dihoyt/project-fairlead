import type { Category, CheckResult } from "@contracts/health";

export const CATEGORY_LABEL: Record<Category, string> = {
  cluster: "Cluster",
  storage: "Storage",
  backups: "Backups",
  gitops: "GitOps",
  hosts: "Hosts",
  checks: "Checks",
  access: "Access",
  identity: "Identity",
  apps: "Apps",
};

export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

const WORKLOAD_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"]);

// The in-app route for a check's object: a node's page, or the workload
// browser's for namespaced kinds it browses; null otherwise.
export function workloadRoute(object: CheckResult["object"]): string | null {
  if (object?.kind === "Node") return `/nodes/${encodeURIComponent(object.name)}`;
  if (!object?.namespace) return null;
  const ns = encodeURIComponent(object.namespace);
  const name = encodeURIComponent(object.name);
  if (object.kind === "Pod") return `/workloads/${ns}/pods/${name}`;
  if (WORKLOAD_KINDS.has(object.kind)) return `/workloads/${ns}/${object.kind}/${name}`;
  return null;
}

export function objectLabel(object: NonNullable<CheckResult["object"]>): string {
  return object.namespace ? `${object.kind} ${object.namespace}/${object.name}` : `${object.kind} ${object.name}`;
}

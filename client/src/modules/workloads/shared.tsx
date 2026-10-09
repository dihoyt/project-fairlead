import type { ReactNode } from "react";
import { Alert, Anchor, Badge, Breadcrumbs, Group, Loader, Text, Tooltip } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { Link } from "react-router";
import type { ManagedBy } from "@contracts/k8s";
import type { PodView, WorkloadKind, WorkloadView } from "@contracts/workloads";
import { absoluteTime, relativeTime, useApi, type Status } from "../../ui";

export const WORKLOAD_KINDS: readonly WorkloadKind[] = ["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"];

export function isWorkloadKind(kind: string | undefined): kind is WorkloadKind {
  return (WORKLOAD_KINDS as readonly string[]).includes(kind ?? "");
}

const enc = encodeURIComponent;
export const spacesPath = "/workloads";
export const spacePath = (namespace: string, tab?: "workloads" | "pods" | "events") =>
  `/workloads/${enc(namespace)}${tab && tab !== "workloads" ? `?tab=${tab}` : ""}`;
export const workloadPath = (namespace: string, kind: string, name: string) =>
  `/workloads/${enc(namespace)}/${enc(kind)}/${enc(name)}`;
export const podPath = (namespace: string, pod: string) => `/workloads/${enc(namespace)}/pods/${enc(pod)}`;

export function splitRef(ref: string): { kind: string; name: string } {
  const slash = ref.indexOf("/");
  return { kind: ref.slice(0, slash), name: ref.slice(slash + 1) };
}

// "Deployment/web" as a link when it names something this browser shows.
export function OwnerLink({ namespace, owner }: { namespace: string; owner?: string }) {
  if (!owner) return <Text c="dimmed">—</Text>;
  const { kind, name } = splitRef(owner);
  if (!isWorkloadKind(kind)) return <Text size="sm">{owner}</Text>;
  return (
    <Anchor component={Link} to={workloadPath(namespace, kind, name)} size="sm">
      {owner}
    </Anchor>
  );
}

const MANAGED_LABEL: Record<ManagedBy, string> = { fleet: "Fleet", helm: "Helm", argo: "Argo CD" };
const MANAGED_COLOR: Record<ManagedBy, string> = { fleet: "blue", helm: "indigo", argo: "orange" };

export function ManagedBadge({ by }: { by: ManagedBy | null }) {
  if (!by) return null;
  return (
    <Tooltip label={`Managed by ${MANAGED_LABEL[by]}: changes made here directly would be reverted.`}>
      <Badge size="sm" variant="outline" color={MANAGED_COLOR[by]} radius="xs">
        {MANAGED_LABEL[by]}
      </Badge>
    </Tooltip>
  );
}

export function Age({ at }: { at: string }) {
  if (!at) return <Text c="dimmed">—</Text>;
  return (
    <Tooltip label={absoluteTime(at)}>
      <Text size="sm" span>
        {relativeTime(at)}
      </Text>
    </Tooltip>
  );
}

const BAD_WAITING = new Set([
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "CreateContainerConfigError",
  "CreateContainerError",
  "InvalidImageName",
  "RunContainerError",
]);

// The one word kubectl would show in its STATUS column, judged.
export function podStatus(pod: PodView): { status: Status; label: string } {
  if (pod.phase === "Succeeded") return { status: "ok", label: "Completed" };
  if (pod.phase === "Terminating") return { status: "unknown", label: "Terminating" };
  if (pod.phase === "Failed") return { status: "crit", label: "Failed" };
  const waiting = pod.containers.find((c) => c.state === "waiting" && c.reason);
  if (waiting?.reason && BAD_WAITING.has(waiting.reason)) return { status: "crit", label: waiting.reason };
  const failed = pod.containers.find((c) => c.state === "terminated" && c.reason !== "Completed");
  if (pod.phase === "Running" && failed?.reason) return { status: "crit", label: failed.reason };
  if (pod.phase === "Pending") return { status: "warn", label: waiting?.reason ?? "Pending" };
  if (pod.phase === "Running") {
    return pod.containers.every((c) => c.ready)
      ? { status: "ok", label: "Running" }
      : { status: "warn", label: "Not ready" };
  }
  return { status: "unknown", label: pod.phase };
}

export function workloadStatus(w: WorkloadView): { status: Status; label: string } {
  switch (w.kind) {
    case "CronJob":
      return w.ready === "suspended" ? { status: "absent", label: "Suspended" } : { status: "ok", label: "Scheduled" };
    case "Job":
      if (w.finished === "failed") return { status: "crit", label: "Failed" };
      return w.finished === "complete" || w.available >= w.desired
        ? { status: "ok", label: "Complete" }
        : { status: "warn", label: "Running" };
    default:
      if (w.desired === 0) return { status: "ok", label: "Scaled to 0" };
      if (w.available >= w.desired) return { status: "ok", label: "Available" };
      if (w.available === 0) return { status: "crit", label: "Unavailable" };
      return { status: "warn", label: "Degraded" };
  }
}

export function Trail({ items }: { items: Array<{ label: string; to?: string }> }) {
  return (
    <Breadcrumbs separatorMargin={6}>
      {items.map((item) =>
        item.to ? (
          <Anchor key={item.label} component={Link} to={item.to} size="sm">
            {item.label}
          </Anchor>
        ) : (
          <Text key={item.label} size="sm" c="dimmed">
            {item.label}
          </Text>
        )
      )}
    </Breadcrumbs>
  );
}

// Loading, error and empty states shared by every list on these pages. A
// failed refresh keeps showing the last good data above the error.
export function Loaded<T>({
  data,
  error,
  loading,
  empty,
  children,
}: {
  data: T[] | null;
  error: string | null;
  loading: boolean;
  empty: string;
  children: (items: T[]) => ReactNode;
}) {
  return (
    <>
      {error ? (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      ) : null}
      {loading && !data ? <Loader size="sm" /> : null}
      {data && data.length === 0 ? <Text c="dimmed">{empty}</Text> : null}
      {data && data.length > 0 ? children(data) : null}
    </>
  );
}

const HEADLAMP_PLURAL: Record<string, string> = {
  Namespace: "namespaces",
  Pod: "pods",
  Deployment: "deployments",
  StatefulSet: "statefulsets",
  DaemonSet: "daemonsets",
  Job: "jobs",
  CronJob: "cronjobs",
};

const RANCHER_TYPE: Record<string, string> = {
  Namespace: "namespace",
  Pod: "pod",
  Deployment: "apps.deployment",
  StatefulSet: "apps.statefulset",
  DaemonSet: "apps.daemonset",
  Job: "batch.job",
  CronJob: "batch.cronjob",
};

// The same object in Headlamp and Rancher, for whichever the install has.
// A namespace is addressed by name alone; everything else by namespace/name.
export function NativeLinks({ kind, namespace, name }: { kind: string; namespace: string; name: string }) {
  const { data } = useApi("GET /api/workloads/links");
  const object = kind === "Namespace" ? enc(name) : `${enc(namespace)}/${enc(name)}`;
  const links: Array<{ label: string; href: string }> = [];
  if (data?.headlamp && HEADLAMP_PLURAL[kind]) {
    links.push({
      label: "Headlamp",
      href: `${data.headlamp.url}/c/${enc(data.headlamp.cluster)}/${HEADLAMP_PLURAL[kind]}/${object}`,
    });
  }
  if (data?.rancher && RANCHER_TYPE[kind]) {
    links.push({
      label: "Rancher",
      href: `${data.rancher.url}/dashboard/c/${enc(data.rancher.clusterId)}/explorer/${RANCHER_TYPE[kind]}/${object}`,
    });
  }
  if (links.length === 0) return null;
  return (
    <Group gap="md">
      {links.map((link) => (
        <Anchor key={link.label} href={link.href} target="_blank" rel="noreferrer" size="sm">
          <Group gap={4} wrap="nowrap">
            Open in {link.label}
            <IconExternalLink size={14} />
          </Group>
        </Anchor>
      ))}
    </Group>
  );
}

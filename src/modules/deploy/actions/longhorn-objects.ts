import type { BackupSchedule } from "../../../contracts/backups.js";
import type { DeployActionKind } from "../../../contracts/deploy.js";
import { RESOURCES, type K8sApi, type KubeObject } from "../../../contracts/k8s.js";
import { product } from "../../../product.js";
import type { ActionContext, ActionRendered } from "./index.js";
import { blockedAction } from "./migrate.js";

// What the backup set-up actions share: the Longhorn objects they read and
// write, rendered here so the Jobs only apply files. Everything Longhorn
// keeps lives in longhorn-system.

export const LONGHORN_NAMESPACE = "longhorn-system";
export const LONGHORN_API = "longhorn.io/v1beta2";
// The lock every backup set-up action takes, so one runs at a time.
export const LONGHORN_RELEASE = "longhorn";
// A volume in no group is in Longhorn's "default" group; labelling it into
// any group takes it out of default unless default is labelled too.
export const GROUP_LABEL_PREFIX = "recurring-job-group.longhorn.io/";
export const DEFAULT_GROUP = "default";

export const SNAPSHOT_RETAIN = 24;
export const BACKUP_RETAIN = 14;

export const recurringJobName = (group: string, task: "snapshot" | "backup") =>
  `${product.ownerMarker.externalPrefix}${group}-${task}`;

export interface LonghornVolume extends KubeObject {
  spec?: { numberOfReplicas?: number; size?: string; dataEngine?: string; accessMode?: string; fromBackup?: string };
  status?: {
    state?: string;
    restoreRequired?: boolean;
    kubernetesStatus?: { namespace?: string; pvcName?: string; pvName?: string };
  };
}

export interface LonghornBackup extends KubeObject {
  spec?: { snapshotName?: string };
  status?: {
    state?: string;
    url?: string;
    volumeName?: string;
    volumeSize?: string;
    size?: string;
    snapshotCreatedAt?: string;
    error?: string;
    labels?: Record<string, string>;
  };
}

export interface LonghornBackupTarget extends KubeObject {
  spec?: { backupTargetURL?: string; credentialSecret?: string };
  status?: {
    available?: boolean;
    lastSyncedAt?: string;
    conditions?: Array<{ type?: string; status?: string; message?: string }>;
  };
}

export function recurringJobs(schedules: readonly BackupSchedule[], labels: Record<string, string>): KubeObject[] {
  const out: KubeObject[] = [];
  for (const s of schedules) {
    const tasks: Array<["snapshot" | "backup", string | undefined, number]> = [
      ["snapshot", s.snapshotCron, s.snapshotRetain ?? SNAPSHOT_RETAIN],
      ["backup", s.backupCron, s.backupRetain ?? BACKUP_RETAIN],
    ];
    for (const [task, cron, retain] of tasks) {
      if (!cron) continue;
      const name = recurringJobName(s.group, task);
      out.push({
        apiVersion: LONGHORN_API,
        kind: "RecurringJob",
        metadata: { name, namespace: LONGHORN_NAMESPACE, labels },
        spec: { name, task, cron, retain, concurrency: 2, groups: [s.group], labels: {} },
      });
    }
  }
  return out;
}

// The labels that put a volume in exactly these groups; every other group
// label it carries is removed (`key-`). No groups: back in "default".
export function groupLabelArgs(current: Record<string, string> | undefined, groups: readonly string[]): string[] {
  const want = new Set(
    groups.filter((g) => g !== DEFAULT_GROUP || groups.length > 1).map((g) => GROUP_LABEL_PREFIX + g)
  );
  const args = [...want].map((key) => `${key}=enabled`);
  for (const key of Object.keys(current ?? {})) {
    if (key.startsWith(GROUP_LABEL_PREFIX) && !want.has(key)) args.push(`${key}-`);
  }
  return args;
}

export function volumeGroups(volume: KubeObject): string[] {
  const groups = Object.entries(volume.metadata.labels ?? {})
    .filter(([key, value]) => key.startsWith(GROUP_LABEL_PREFIX) && value === "enabled")
    .map(([key]) => key.slice(GROUP_LABEL_PREFIX.length))
    .toSorted();
  return groups.length > 0 ? groups : [DEFAULT_GROUP];
}

export async function volumeOfClaim(
  k8s: K8sApi,
  namespace: string,
  claim: string
): Promise<LonghornVolume | undefined | "absent"> {
  const volumes = await k8s.list<LonghornVolume>(RESOURCES.longhornVolumes, { namespace: LONGHORN_NAMESPACE });
  if (volumes === "absent") return "absent";
  return volumes.find(
    (v) => v.status?.kubernetesStatus?.namespace === namespace && v.status.kubernetesStatus.pvcName === claim
  );
}

export async function readBackupTarget(k8s: K8sApi): Promise<LonghornBackupTarget | null | "absent"> {
  return k8s.get<LonghornBackupTarget>(RESOURCES.longhornBackupTargets, "default", LONGHORN_NAMESPACE);
}

export const unavailableMessage = (t: LonghornBackupTarget) =>
  t.status?.conditions?.find((c) => c.type === "Unavailable" && c.status === "True")?.message;

// The deploy job row every backup set-up action takes.
export const longhornBase = (ctx: ActionContext) => ({
  appId: "longhorn",
  release: LONGHORN_RELEASE,
  namespace: LONGHORN_NAMESPACE,
  version: ctx.versions.get(LONGHORN_RELEASE) ?? "",
});

// Refusals every backup set-up action shares, before it looks further.
export function refuse(kind: DeployActionKind, title: string, ctx: ActionContext): ActionRendered | undefined {
  const base = longhornBase(ctx);
  if (!ctx.k8s) return blockedAction(kind, title, base, "The Kubernetes API is not available.");
  if (!ctx.enabled) {
    return blockedAction(
      kind,
      title,
      base,
      `Deploys are off.${ctx.enableHint ? ` Turn them on with: ${ctx.enableHint}` : ""}`
    );
  }
  return undefined;
}

export const NOT_INSTALLED = "Longhorn is not installed: its objects are not served by this cluster.";

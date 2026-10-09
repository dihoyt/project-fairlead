import type {
  BackupSchedule,
  BackupSchedulesView,
  BackupTargetView,
  VolumeRestorePoint,
} from "../../contracts/backups.js";
import type { StorageTargetService } from "../../contracts/connectors.js";
import { RESOURCES, type K8sApi, type KubeObject } from "../../contracts/k8s.js";
import { product } from "../../product.js";

// What the Backups page reads of Longhorn to set it up: its BackupTarget,
// the RecurringJobs this product made, volumes' groups and their backups.
// Reads only; every change is a deploy action.

const NAMESPACE = "longhorn-system";
const GROUP_LABEL = "recurring-job-group.longhorn.io/";
const DEFAULT_GROUP = "default";

export const SUGGESTED_SCHEDULES: BackupSchedule[] = [
  { group: "default", snapshotCron: "0 * * * *", snapshotRetain: 24, backupCron: "0 3 * * *", backupRetain: 14 },
  { group: "critical", backupCron: "0 */6 * * *", backupRetain: 28 },
];

interface Target extends KubeObject {
  spec?: { backupTargetURL?: string };
  status?: {
    available?: boolean;
    lastSyncedAt?: string;
    conditions?: Array<{ type?: string; status?: string; message?: string }>;
  };
}

interface RecurringJob extends KubeObject {
  spec?: { name?: string; task?: string; cron?: string; retain?: number; groups?: string[] };
}

export interface Volume extends KubeObject {
  status?: { kubernetesStatus?: { namespace?: string; pvcName?: string } };
}

interface Backup extends KubeObject {
  status?: {
    state?: string;
    url?: string;
    volumeName?: string;
    size?: string;
    snapshotCreatedAt?: string;
    error?: string;
    messages?: Record<string, string>;
    labels?: Record<string, string>;
  };
}

const norm = (url: string) => url.trim().replace(/\/+$/, "");
const time = (value: string | undefined) => {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isNaN(ms) || ms <= 0 ? undefined : ms;
};

export async function readTarget(k8s: K8sApi, targets?: StorageTargetService): Promise<BackupTargetView> {
  const found = await k8s.get<Target>(RESOURCES.longhornBackupTargets, "default", NAMESPACE);
  if (found === "absent") return { url: "", longhorn: "absent" };
  const url = found?.spec?.backupTargetURL ?? "";
  const view: BackupTargetView = { url, longhorn: "installed" };
  if (!found || !url) return view;
  if (typeof found.status?.available === "boolean") view.available = found.status.available;
  const message = found.status?.conditions?.find((c) => c.type === "Unavailable" && c.status === "True")?.message;
  if (message) view.message = message;
  if (time(found.status?.lastSyncedAt)) view.lastSyncAt = found.status!.lastSyncedAt;
  const match = targets ? (await targets.list()).find((t) => norm(t.url) === norm(url)) : undefined;
  if (match) Object.assign(view, { connectorId: match.id, name: match.name, protocol: match.protocol });
  return view;
}

export async function readSchedules(k8s: K8sApi): Promise<BackupSchedulesView> {
  const jobs = await k8s.list<RecurringJob>(RESOURCES.longhornRecurringJobs, { namespace: NAMESPACE });
  if (jobs === "absent") return { schedules: [], suggested: SUGGESTED_SCHEDULES, longhorn: "absent" };
  const byGroup = new Map<string, BackupSchedule>();
  for (const job of jobs) {
    const name = job.metadata.name;
    if (!k8s.isOwned(job) || !name.startsWith(product.ownerMarker.externalPrefix)) continue;
    const group = job.spec?.groups?.[0];
    const task = job.spec?.task;
    if (!group || !job.spec?.cron || (task !== "snapshot" && task !== "backup")) continue;
    const s = byGroup.get(group) ?? { group };
    if (task === "snapshot") Object.assign(s, { snapshotCron: job.spec.cron, snapshotRetain: job.spec.retain });
    else Object.assign(s, { backupCron: job.spec.cron, backupRetain: job.spec.retain });
    byGroup.set(group, s);
  }
  const schedules = [...byGroup.values()].toSorted(
    (a, b) => Number(b.group === DEFAULT_GROUP) - Number(a.group === DEFAULT_GROUP) || a.group.localeCompare(b.group)
  );
  return schedules.length > 0
    ? { schedules, longhorn: "installed" }
    : { schedules, suggested: SUGGESTED_SCHEDULES, longhorn: "installed" };
}

export function groupsOf(volume: KubeObject): string[] {
  const groups = Object.entries(volume.metadata.labels ?? {})
    .filter(([key, value]) => key.startsWith(GROUP_LABEL) && value === "enabled")
    .map(([key]) => key.slice(GROUP_LABEL.length))
    .toSorted();
  return groups.length > 0 ? groups : [DEFAULT_GROUP];
}

const volumeOf = (b: Backup) => b.status?.volumeName || b.metadata.labels?.["backup-volume"];
const backupAt = (b: Backup) => time(b.status?.snapshotCreatedAt) ?? time(b.metadata.creationTimestamp);

export interface LonghornVolumes {
  // By "namespace/claim".
  byClaim: Map<string, { volume: Volume; groups: string[]; lastBackupAt?: string }>;
}

export async function readVolumes(k8s: K8sApi): Promise<LonghornVolumes | "absent"> {
  const [volumes, backups] = await Promise.all([
    k8s.list<Volume>(RESOURCES.longhornVolumes, { namespace: NAMESPACE }),
    k8s.list<Backup>(RESOURCES.longhornBackups, { namespace: NAMESPACE }),
  ]);
  if (volumes === "absent") return "absent";
  const newest = new Map<string, number>();
  for (const b of backups === "absent" ? [] : backups) {
    const vol = volumeOf(b);
    const at = backupAt(b);
    if (!vol || at === undefined || b.status?.state !== "Completed") continue;
    if (at > (newest.get(vol) ?? 0)) newest.set(vol, at);
  }
  const byClaim: LonghornVolumes["byClaim"] = new Map();
  for (const volume of volumes) {
    const k = volume.status?.kubernetesStatus;
    if (!k?.namespace || !k.pvcName) continue;
    const at = newest.get(volume.metadata.name);
    byClaim.set(`${k.namespace}/${k.pvcName}`, {
      volume,
      groups: groupsOf(volume),
      ...(at ? { lastBackupAt: new Date(at).toISOString() } : {}),
    });
  }
  return { byClaim };
}

const STATE: Record<string, VolumeRestorePoint["state"]> = { Completed: "completed", Error: "error" };

export async function restorePoints(k8s: K8sApi, volumeName: string): Promise<VolumeRestorePoint[]> {
  const backups = await k8s.list<Backup>(RESOURCES.longhornBackups, { namespace: NAMESPACE });
  if (backups === "absent") return [];
  return backups
    .filter((b) => volumeOf(b) === volumeName)
    .map((b): VolumeRestorePoint => {
      const at = backupAt(b);
      const size = Number(b.status?.size);
      const by = b.status?.labels?.["RecurringJob"];
      const message = b.status?.error || Object.values(b.status?.messages ?? {}).find(Boolean);
      return {
        id: b.metadata.name,
        at: new Date(at ?? 0).toISOString(),
        state: STATE[b.status?.state ?? ""] ?? "in-progress",
        ...(Number.isFinite(size) && size > 0 ? { sizeBytes: size } : {}),
        createdBy: by || "manual",
        ...(b.status?.url ? { url: b.status.url } : {}),
        ...(message ? { message } : {}),
      };
    })
    .toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

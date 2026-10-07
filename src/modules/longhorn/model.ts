import { RESOURCES } from "../../contracts/k8s.js";
import type { K8sApi, KubeObject, ResourceRef } from "../../contracts/k8s.js";
import { longestGapMs, parseCron, previousFires, type Cron } from "./cron.js";

// The fields of longhorn.io/v1beta2 objects this module reads. Older
// managers omit some (BackupTarget CRs arrived in 1.6, backupTargetName on
// volumes in 1.8), so every one is optional.

export interface LonghornVolume extends KubeObject {
  spec?: {
    size?: string;
    numberOfReplicas?: number;
    fromBackup?: string;
    backupTargetName?: string;
  };
  status?: {
    state?: string;
    robustness?: string;
    currentNodeID?: string;
    actualSize?: string;
    lastBackup?: string;
    lastBackupAt?: string;
    kubernetesStatus?: {
      pvName?: string;
      pvcName?: string;
      namespace?: string;
      workloadsStatus?: Array<{ podName?: string; podStatus?: string; workloadName?: string; workloadType?: string }>;
    };
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
  };
}

export interface LonghornBackup extends KubeObject {
  spec?: { snapshotName?: string; labels?: Record<string, string> };
  status?: {
    state?: string;
    snapshotCreatedAt?: string;
    backupCreatedAt?: string;
    volumeName?: string;
    url?: string;
    error?: string;
    messages?: Record<string, string> | null;
  };
}

export interface LonghornBackupVolume extends KubeObject {
  status?: { lastBackupAt?: string; lastBackupName?: string };
}

export interface LonghornBackupTarget extends KubeObject {
  spec?: { backupTargetURL?: string; pollInterval?: string };
  status?: {
    available?: boolean;
    lastSyncedAt?: string;
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
  };
}

export interface LonghornRecurringJob extends KubeObject {
  spec?: { name?: string; task?: string; cron?: string; groups?: string[]; retain?: number };
  status?: { executionCount?: number };
}

export interface LonghornSetting extends KubeObject {
  value?: string;
}

export interface LonghornNode extends KubeObject {
  spec?: { allowScheduling?: boolean };
  status?: {
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
    diskStatus?: Record<
      string,
      {
        storageMaximum?: number;
        storageAvailable?: number;
        storageScheduled?: number;
        conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
      }
    >;
  };
}

export interface LonghornReplica extends KubeObject {
  spec?: { volumeName?: string; nodeID?: string; failedAt?: string };
  status?: { currentState?: string };
}

export interface LonghornSnapshot extends KubeObject {
  spec?: { volume?: string; labels?: Record<string, string> | null };
  status?: {
    creationTime?: string;
    error?: string;
    readyToUse?: boolean;
    userCreated?: boolean;
    markRemoved?: boolean;
    labels?: Record<string, string> | null;
  };
}

// A read that may be refused without failing the rest: the reason it was.
export type Readable<T> = T[] | { error: string };

export const readable = <T>(r: Readable<T>): T[] | undefined => (Array.isArray(r) ? r : undefined);

export interface Snapshot {
  takenAt: number;
  volumes: LonghornVolume[];
  backups: LonghornBackup[];
  backupVolumes: LonghornBackupVolume[];
  targets: LonghornBackupTarget[];
  jobs: LonghornRecurringJob[];
  settings: LonghornSetting[];
  // Later additions to the chart's ClusterRole: an install on an older
  // chart can't read them, and that hides only the checks built on them.
  nodes: Readable<LonghornNode>;
  replicas: Readable<LonghornReplica>;
  snapshots: Readable<LonghornSnapshot>;
  // "<namespace>/<name>" to uid; empty when PVCs can't be read.
  pvcUids: Map<string, string>;
}

export type Load = () => Promise<Snapshot | "absent">;

const orEmpty = <T>(list: T[] | "absent"): T[] => (list === "absent" ? [] : list);

function tolerant<T extends KubeObject>(api: K8sApi, ref: ResourceRef): Promise<Readable<T>> {
  return api.list<T>(ref).then(
    (list) => (list === "absent" ? [] : list),
    (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) })
  );
}

// One read of everything Longhorn, shared by the health providers, the
// metrics collector and the backup source for `ttlMs`, so a tick of all
// three costs one set of list calls. Concurrent callers share a load.
export function createLoader(k8s: () => K8sApi, now: () => number, ttlMs = 10_000): Load {
  let cached: { at: number; value: Snapshot | "absent" } | undefined;
  let inflight: Promise<Snapshot | "absent"> | undefined;

  async function read(): Promise<Snapshot | "absent"> {
    const api = k8s();
    const volumes = await api.list<LonghornVolume>(RESOURCES.longhornVolumes);
    if (volumes === "absent") return "absent";
    const [backups, backupVolumes, targets, jobs, settings, pvcs, nodes, replicas, snapshots] = await Promise.all([
      api.list<LonghornBackup>(RESOURCES.longhornBackups),
      api.list<LonghornBackupVolume>(RESOURCES.longhornBackupVolumes),
      api.list<LonghornBackupTarget>(RESOURCES.longhornBackupTargets),
      api.list<LonghornRecurringJob>(RESOURCES.longhornRecurringJobs),
      api.list<LonghornSetting>(RESOURCES.longhornSettings),
      // PVC uids are only for the posture page's join; a denied read leaves
      // them blank rather than failing every Longhorn check.
      api.list(RESOURCES.pvcs).catch(() => [] as KubeObject[]),
      tolerant<LonghornNode>(api, RESOURCES.longhornNodes),
      tolerant<LonghornReplica>(api, RESOURCES.longhornReplicas),
      tolerant<LonghornSnapshot>(api, RESOURCES.longhornSnapshots),
    ]);
    const pvcUids = new Map<string, string>();
    for (const pvc of orEmpty(pvcs)) {
      if (pvc.metadata.uid) pvcUids.set(`${pvc.metadata.namespace}/${pvc.metadata.name}`, pvc.metadata.uid);
    }
    return {
      takenAt: now(),
      volumes,
      backups: orEmpty(backups),
      backupVolumes: orEmpty(backupVolumes),
      targets: orEmpty(targets),
      jobs: orEmpty(jobs),
      settings: orEmpty(settings),
      nodes,
      replicas,
      snapshots,
      pvcUids,
    };
  }

  return async () => {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    inflight ??= read()
      .then((value) => {
        cached = { at: now(), value };
        return value;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}

// --- derived views ---------------------------------------------------------

const BACKUP_TASKS = new Set(["backup", "backup-force-create"]);
const JOB_LABEL = "recurring-job.longhorn.io/";
const GROUP_LABEL = "recurring-job-group.longhorn.io/";

export const isBackupJob = (job: LonghornRecurringJob) => BACKUP_TASKS.has(job.spec?.task ?? "");
export const isSnapshotJob = (job: LonghornRecurringJob) =>
  job.spec?.task === "snapshot" || job.spec?.task === "snapshot-force-create";
export const jobName = (job: LonghornRecurringJob) => job.spec?.name || job.metadata.name;

export function time(value: string | undefined | null): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

export function pvcOf(volume: LonghornVolume): { namespace: string; name: string } | undefined {
  const k = volume.status?.kubernetesStatus;
  return k?.namespace && k.pvcName ? { namespace: k.namespace, name: k.pvcName } : undefined;
}

export function volumeLabel(volume: LonghornVolume): string {
  const pvc = pvcOf(volume);
  return pvc ? `${pvc.namespace}/${pvc.name}` : volume.metadata.name;
}

// Longhorn applies a job to a volume labelled with the job's name or one of
// its groups; a volume with no job or group label at all gets the jobs in
// the "default" group.
export function jobsFor(volume: LonghornVolume, jobs: LonghornRecurringJob[]): LonghornRecurringJob[] {
  const labels = volume.metadata.labels ?? {};
  const enabled = (prefix: string) =>
    Object.entries(labels)
      .filter(([key, value]) => key.startsWith(prefix) && value === "enabled")
      .map(([key]) => key.slice(prefix.length));
  const named = new Set(enabled(JOB_LABEL));
  const groups = new Set(enabled(GROUP_LABEL));
  if (named.size === 0 && groups.size === 0) groups.add("default");
  return jobs.filter((job) => named.has(jobName(job)) || (job.spec?.groups ?? []).some((g) => groups.has(g)));
}

export function volumesFor(job: LonghornRecurringJob, volumes: LonghornVolume[], jobs: LonghornRecurringJob[]) {
  return volumes.filter((v) => jobsFor(v, jobs).includes(job));
}

export function backupsOf(volume: LonghornVolume, backups: LonghornBackup[]): LonghornBackup[] {
  const name = volume.metadata.name;
  return backups.filter((b) => b.status?.volumeName === name || b.metadata.labels?.["backup-volume"] === name);
}

// When a backup was taken: the snapshot's time, which is what a restore
// gives back, falling back to the object's creation.
export const backupTime = (b: LonghornBackup) =>
  time(b.status?.snapshotCreatedAt) ?? time(b.metadata.creationTimestamp) ?? 0;

export const backupError = (b: LonghornBackup) =>
  b.status?.error || Object.values(b.status?.messages ?? {}).find(Boolean) || undefined;

const FINISHED_STATES = new Set(["Completed", "Error"]);

export interface BackupHistory {
  lastGood?: LonghornBackup;
  // The newest backup that finished either way.
  lastFinished?: LonghornBackup;
  // When the volume's status records a backup the Backup objects don't have
  // (not yet synced from the target), its time.
  statusLastBackupAt?: number;
  statusLastBackup?: string;
}

export function historyOf(volume: LonghornVolume, backups: LonghornBackup[]): BackupHistory {
  const mine = backupsOf(volume, backups).toSorted((a, b) => backupTime(b) - backupTime(a));
  return {
    lastGood: mine.find((b) => b.status?.state === "Completed"),
    lastFinished: mine.find((b) => FINISHED_STATES.has(b.status?.state ?? "")),
    statusLastBackupAt: time(volume.status?.lastBackupAt),
    statusLastBackup: volume.status?.lastBackup || undefined,
  };
}

export function lastGoodAt(history: BackupHistory): { at: number; ref: string } | undefined {
  const fromObject = history.lastGood
    ? { at: backupTime(history.lastGood), ref: history.lastGood.metadata.name }
    : undefined;
  const fromStatus =
    history.statusLastBackupAt !== undefined && history.statusLastBackup
      ? { at: history.statusLastBackupAt, ref: history.statusLastBackup }
      : undefined;
  if (fromObject && fromStatus) return fromStatus.at > fromObject.at ? fromStatus : fromObject;
  return fromObject ?? fromStatus;
}

// --- targets ---------------------------------------------------------------

export interface Target {
  name: string;
  url: string;
  available?: boolean;
  message?: string;
}

// Credentials never belong in a URL shown on a page. Only a user:password
// pair is userinfo here: Longhorn's s3 form is s3://bucket@region/path.
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@:]*:[^/@]*@/i, "$1");
}

export function targetsOf(snapshot: Snapshot): Target[] {
  if (snapshot.targets.length) {
    return snapshot.targets.map((t) => {
      const unavailable = t.status?.conditions?.find((c) => c.type === "Unavailable" && c.status === "True");
      return {
        name: t.metadata.name,
        url: redactUrl(t.spec?.backupTargetURL ?? ""),
        ...(t.status?.available === undefined ? {} : { available: t.status.available }),
        ...(unavailable?.message ? { message: unavailable.message } : {}),
      };
    });
  }
  // Before BackupTarget objects existed the target was a setting.
  const setting = snapshot.settings.find((s) => s.metadata.name === "backup-target")?.value;
  return setting ? [{ name: "default", url: redactUrl(setting) }] : [];
}

export function targetOf(volume: LonghornVolume, targets: Target[]): Target | undefined {
  const name = volume.spec?.backupTargetName || "default";
  return targets.find((t) => t.name === name);
}

export const targetId = (t: Target) => `longhorn:${t.url || t.name}`;

// --- schedules -------------------------------------------------------------

export interface Schedule {
  job: LonghornRecurringJob;
  cron: Cron | null;
  expectedEveryMs?: number;
}

export function scheduleOf(job: LonghornRecurringJob, now: number): Schedule {
  const cron = parseCron(job.spec?.cron ?? "");
  const every = cron ? longestGapMs(cron, now) : undefined;
  return { job, cron, ...(every === undefined ? {} : { expectedEveryMs: every }) };
}

// How many scheduled runs have come due (fire time plus grace before
// `now`) since `since` without anything newer than them. 0 when the newest
// due run is covered.
export function missedRuns(
  schedules: Schedule[],
  since: number,
  now: number,
  graceMs: number
): {
  missed: number;
  lastDue?: number;
} {
  const due = schedules
    .flatMap((s) => (s.cron ? previousFires(s.cron, now - graceMs, 3) : []))
    .toSorted((a, b) => b - a);
  const lastDue = due[0];
  const missed = due.filter((at) => at > since).length;
  return { missed: Math.min(missed, 3), ...(lastDue === undefined ? {} : { lastDue }) };
}

// --- replicas and snapshots --------------------------------------------------

export function replicasOf(volume: LonghornVolume, replicas: LonghornReplica[]): LonghornReplica[] {
  const name = volume.metadata.name;
  return replicas.filter((r) => r.spec?.volumeName === name || r.metadata.labels?.["longhornvolume"] === name);
}

export function snapshotsOf(volume: LonghornVolume, snapshots: LonghornSnapshot[]): LonghornSnapshot[] {
  const name = volume.metadata.name;
  return snapshots.filter((s) => s.spec?.volume === name || s.metadata.labels?.["longhornvolume"] === name);
}

export const snapshotTime = (s: LonghornSnapshot) =>
  time(s.status?.creationTime) ?? time(s.metadata.creationTimestamp) ?? 0;

// Longhorn tags what a recurring job creates with the job's name.
export const snapshotJob = (s: LonghornSnapshot) =>
  s.status?.labels?.["RecurringJob"] ?? s.spec?.labels?.["RecurringJob"] ?? undefined;

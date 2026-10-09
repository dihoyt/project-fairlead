import type { BackupSource, ProtectedVolume } from "../../contracts/backups.js";
import type { StorageTargetService, StorageTargetView } from "../../contracts/connectors.js";
import type { Status } from "../../contracts/health.js";
import { RESOURCES, type K8sApi, type KubeObject } from "../../contracts/k8s.js";
import { POSTGRES_NAMESPACE, type PostgresBackupView, type PostgresRestorePoint } from "../../contracts/postgres.js";
import { product } from "../../product.js";
import type { CnpgCluster, Condition, Snapshot } from "./read.js";

// The shared cluster's backups as the operator, the Barman Cloud plugin and
// the dump CronJob report them. Found by what they point at, not by name:
// the cluster's archiver plugin names its ObjectStore, the ScheduledBackup
// and Backups name their cluster, and the dump CronJob is the one this
// product made in the namespace.

const BARMAN_PLUGIN = "barman-cloud.cloudnative-pg.io";
const MANAGED_BY = "app.kubernetes.io/managed-by";
const HOUR = 3_600_000;
const RECENT = 10;

interface ObjectStore extends KubeObject {
  spec?: { retentionPolicy?: string; configuration?: { destinationPath?: string } };
  status?: {
    serverRecoveryWindow?: Record<
      string,
      { firstRecoverabilityPoint?: string; lastSuccessfulBackupTime?: string; lastFailedBackupTime?: string }
    >;
  };
}

interface ScheduledBackup extends KubeObject {
  spec?: { schedule?: string; cluster?: { name?: string } };
}

interface Backup extends KubeObject {
  spec?: { cluster?: { name?: string } };
  status?: { phase?: string; startedAt?: string; stoppedAt?: string; error?: string };
}

interface CronJob extends KubeObject {
  spec?: {
    schedule?: string;
    successfulJobsHistoryLimit?: number;
    jobTemplate?: {
      spec?: { template?: { spec?: { volumes?: Array<{ persistentVolumeClaim?: { claimName?: string } }> } } };
    };
  };
}

interface Job extends KubeObject {
  status?: {
    startTime?: string;
    completionTime?: string;
    succeeded?: number;
    conditions?: Array<{ type?: string; status?: string; message?: string }>;
  };
}

interface Pvc extends KubeObject {
  metadata: KubeObject["metadata"] & { uid?: string };
}

export interface BackupObjects {
  stores: ObjectStore[];
  schedules: ScheduledBackup[];
  backups: Backup[];
  crons: CronJob[];
  jobs: Job[];
  // Longhorn's backup target URL, which the dumps' volume is backed up to.
  longhornTarget?: string;
}

const items = <T>(listed: T[] | "absent") => (listed === "absent" ? [] : listed);

export async function readBackupObjects(k8s: K8sApi): Promise<BackupObjects> {
  const namespace = POSTGRES_NAMESPACE;
  const [stores, schedules, backups, crons, jobs, longhorn] = await Promise.all([
    k8s.list<ObjectStore>(RESOURCES.barmanObjectStores, { namespace }),
    k8s.list<ScheduledBackup>(RESOURCES.cnpgScheduledBackups, { namespace }),
    k8s.list<Backup>(RESOURCES.cnpgBackups, { namespace }),
    k8s.list<CronJob>(RESOURCES.cronJobs, { namespace }),
    k8s.list<Job>(RESOURCES.jobs, { namespace }),
    k8s
      .get<KubeObject & { spec?: { backupTargetURL?: string } }>(
        RESOURCES.longhornBackupTargets,
        "default",
        "longhorn-system"
      )
      .catch(() => null),
  ]);
  const longhornTarget = longhorn && longhorn !== "absent" ? longhorn.spec?.backupTargetURL : undefined;
  return {
    stores: items(stores),
    schedules: items(schedules),
    backups: items(backups),
    crons: items(crons).filter((c) => c.metadata.labels?.[MANAGED_BY] === product.ownerMarker.labelDomain),
    jobs: items(jobs),
    ...(longhornTarget ? { longhornTarget } : {}),
  };
}

const archiverOf = (cluster: CnpgCluster) =>
  cluster.spec?.plugins?.find((p) => p.name === BARMAN_PLUGIN && p.isWALArchiver);

// Roughly how often a five- or six-field cron fires, to judge a backup's
// age: weekly or monthly fields win, then the hour field.
export function cronIntervalMs(cron: string | undefined): number {
  const f = (cron ?? "").trim().split(/\s+/).slice(-5);
  if (f.length < 5) return 24 * HOUR;
  if (f[4] !== "*") return 7 * 24 * HOUR;
  if (f[2] !== "*") return 31 * 24 * HOUR;
  const hour = f[1]!;
  if (hour === "*") return HOUR;
  const step = /^\*\/(\d+)$/.exec(hour);
  if (step) return Number(step[1]) * HOUR;
  if (hour.includes(",")) return (24 / hour.split(",").length) * HOUR;
  return 24 * HOUR;
}

const fiveField = (cron: string | undefined) => (cron ? cron.trim().split(/\s+/).slice(-5).join(" ") : undefined);

// Older than one interval and a half (plus an hour of grace) warns; three
// intervals is critical.
export function ageStatus(at: string | undefined, intervalMs: number, now: Date): Status {
  if (!at) return "warn";
  const age = now.getTime() - new Date(at).getTime();
  if (age > 3 * intervalMs) return "crit";
  if (age > 1.5 * intervalMs + HOUR) return "warn";
  return "ok";
}

export function ago(at: string, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - new Date(at).getTime()) / 1000));
  if (s < 90) return `${s} seconds ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)} minutes ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

const RANK: Status[] = ["crit", "warn", "unknown", "ok", "absent"];
const worst = (...all: Status[]) => RANK.find((s) => all.includes(s)) ?? "ok";

const condition = (cluster: CnpgCluster, type: string): Condition | undefined =>
  cluster.status?.conditions?.find((c) => c.type === type);

// "s3://backups/cluster-a/postgres/" belongs to the target whose URL is
// "s3://backups@region/cluster-a/".
function targetOfArchive(path: string | undefined, targets: StorageTargetView[]) {
  if (!path) return undefined;
  return targets.find((t) => {
    const m = /^s3:\/\/([^@/]+)(?:@[^/]*)?\/?(.*)$/.exec(t.url);
    if (!m) return false;
    const prefix = m[2]!.replace(/^\/+|\/+$/g, "");
    return path === `s3://${m[1]}/${prefix ? `${prefix}/` : ""}postgres/`;
  });
}

const backupPoint = (b: Backup): PostgresRestorePoint => {
  const phase = (b.status?.phase ?? "").toLowerCase();
  const state = phase === "completed" ? "completed" : phase === "failed" ? "failed" : "running";
  return {
    id: b.metadata.name,
    kind: "base-backup",
    at: b.status?.stoppedAt ?? b.status?.startedAt ?? b.metadata.creationTimestamp ?? "",
    state,
    ...(b.status?.error ? { message: b.status.error } : {}),
  };
};

const jobOk = (j: Job) =>
  (j.status?.succeeded ?? 0) > 0 || !!j.status?.conditions?.some((c) => c.type === "Complete" && c.status === "True");
const jobFailed = (j: Job) => j.status?.conditions?.find((c) => c.type === "Failed" && c.status === "True");

const dumpPoint = (j: Job): PostgresRestorePoint => {
  const failed = jobFailed(j);
  return {
    id: j.metadata.name,
    kind: "dump",
    at: j.status?.completionTime ?? j.status?.startTime ?? j.metadata.creationTimestamp ?? "",
    state: jobOk(j) ? "completed" : failed ? "failed" : "running",
    ...(failed?.message ? { message: failed.message } : {}),
  };
};

const newestFirst = (a: PostgresRestorePoint, b: PostgresRestorePoint) => b.at.localeCompare(a.at);

export interface BackupState {
  view: PostgresBackupView;
  // How often a good backup is expected, for the posture.
  intervalMs: number;
}

export async function backupView(
  snapshot: Snapshot,
  objects: BackupObjects,
  targets: StorageTargetService | undefined,
  now: Date
): Promise<BackupState> {
  const checkedAt = now.toISOString();
  const cluster = snapshot.current;
  if (!cluster) {
    return {
      view: {
        method: "none",
        reason: "There is no shared Postgres to back up.",
        status: "absent",
        detail: "No shared Postgres cluster",
        restorePoints: [],
        checkedAt,
      },
      intervalMs: 24 * HOUR,
    };
  }
  const list = targets ? await targets.list().catch(() => []) : [];
  const name = cluster.metadata.name;
  const plugin = archiverOf(cluster);

  if (plugin) {
    const serverName = plugin.parameters?.serverName ?? name;
    const store = objects.stores.find((s) => s.metadata.name === plugin.parameters?.barmanObjectName);
    const window = store?.status?.serverRecoveryWindow?.[serverName];
    const schedule = objects.schedules.find((s) => s.spec?.cluster?.name === name);
    const cron = fiveField(schedule?.spec?.schedule);
    const intervalMs = cronIntervalMs(cron);
    const destination = store?.spec?.configuration?.destinationPath;
    const target = targetOfArchive(destination, list);
    const retention = Number(/^(\d+)d$/.exec(store?.spec?.retentionPolicy ?? "")?.[1]) || undefined;
    const points = objects.backups
      .filter((b) => b.spec?.cluster?.name === name)
      .map(backupPoint)
      .toSorted(newestFirst);
    const lastBaseBackup = window?.lastSuccessfulBackupTime ?? points.find((p) => p.state === "completed")?.at;
    const lastFailedPoint = points.find((p) => p.state === "failed");
    const lastFailedAt = window?.lastFailedBackupTime ?? lastFailedPoint?.at;
    const archived = condition(cluster, "ContinuousArchiving");
    const archiving = archived
      ? {
          ok: archived.status === "True",
          ...(archived.status !== "True" && archived.message ? { message: archived.message } : {}),
        }
      : undefined;

    const parts: string[] = [];
    const statuses: Status[] = [];
    if (!store) {
      statuses.push("crit");
      parts.push(`ObjectStore ${plugin.parameters?.barmanObjectName ?? "?"} is missing`);
    }
    if (archiving) {
      statuses.push(archiving.ok ? "ok" : "crit");
      parts.push(
        archiving.ok ? "WAL archiving on" : `WAL archiving failing${archiving.message ? `: ${archiving.message}` : ""}`
      );
    } else {
      statuses.push("unknown");
      parts.push("WAL archiving not reported yet");
    }
    if (lastBaseBackup) {
      statuses.push(ageStatus(lastBaseBackup, intervalMs, now));
      parts.push(`last base backup ${ago(lastBaseBackup, now)}`);
    } else {
      statuses.push(points.some((p) => p.state === "running") ? "unknown" : "warn");
      parts.push("no base backup yet");
    }
    if (lastFailedAt && (!lastBaseBackup || lastFailedAt > lastBaseBackup)) {
      statuses.push("warn");
      parts.push(`the last one failed ${ago(lastFailedAt, now)}`);
    }
    const label = target?.name ?? destination ?? "object storage";
    return {
      intervalMs,
      view: {
        method: "pitr",
        reason: `${label} is object storage: base backups and every WAL segment, restore to any moment.`,
        ...(target ? { connectorId: target.id, targetName: target.name, protocol: target.protocol } : {}),
        ...(destination ? { destination } : {}),
        ...(cron ? { schedule: cron } : {}),
        ...(retention ? { retention } : {}),
        status: worst(...statuses),
        detail: parts.join("; ").replace(/^./, (c) => c.toUpperCase()),
        ...(window?.firstRecoverabilityPoint ? { firstRecoverabilityPoint: window.firstRecoverabilityPoint } : {}),
        ...(lastBaseBackup ? { lastBaseBackup } : {}),
        ...(lastFailedAt
          ? {
              lastFailedBackup: {
                at: lastFailedAt,
                ...(lastFailedPoint?.message ? { message: lastFailedPoint.message } : {}),
              },
            }
          : {}),
        ...(archiving ? { archiving } : {}),
        restorePoints: points.slice(0, RECENT * 3),
        checkedAt,
      },
    };
  }

  const cron = objects.crons[0];
  if (cron) {
    const prefix = `${cron.metadata.name}-`;
    const points = objects.jobs
      .filter((j) => j.metadata.name.startsWith(prefix))
      .map(dumpPoint)
      .toSorted(newestFirst);
    const intervalMs = cronIntervalMs(cron.spec?.schedule);
    const last = points.find((p) => p.state !== "running");
    const lastGood = points.find((p) => p.state === "completed");
    // The CronJob mounts the dumps' claim; Longhorn backs it up to its own target.
    const claim = cron.spec?.jobTemplate?.spec?.template?.spec?.volumes?.find((v) => v.persistentVolumeClaim)
      ?.persistentVolumeClaim?.claimName;
    const target = objects.longhornTarget ? list.find((t) => t.url === objects.longhornTarget) : undefined;
    const statuses: Status[] = [ageStatus(lastGood?.at, intervalMs, now)];
    const parts = [lastGood ? `Last dump ${ago(lastGood.at, now)}` : "No dump yet"];
    if (last && last.state === "failed") {
      statuses.push("warn");
      parts.push(`the last one failed${last.message ? `: ${last.message}` : ""}`);
    }
    const label = target?.name ?? "The storage target";
    return {
      intervalMs,
      view: {
        method: "dump",
        reason: `${label} takes no WAL archive: dumps onto a Longhorn volume that Longhorn backs up there. Restore to the moment of a dump.`,
        ...(target ? { connectorId: target.id, targetName: target.name, protocol: target.protocol } : {}),
        ...(claim ? { destination: `${POSTGRES_NAMESPACE}/${claim}` } : {}),
        ...(cron.spec?.schedule ? { schedule: cron.spec.schedule } : {}),
        ...(cron.spec?.successfulJobsHistoryLimit ? { retention: cron.spec.successfulJobsHistoryLimit } : {}),
        status: points.length === 0 ? "unknown" : worst(...statuses),
        detail: parts.join("; "),
        ...(last
          ? {
              lastDump: {
                at: last.at,
                ok: last.state === "completed",
                ...(last.message ? { message: last.message } : {}),
              },
            }
          : {}),
        restorePoints: points,
        checkedAt,
      },
    };
  }

  return {
    intervalMs: 24 * HOUR,
    view: {
      method: "none",
      reason: "Not backed up. Pick a storage target: S3/MinIO for point-in-time restore, NFS or SMB for nightly dumps.",
      status: "warn",
      detail: "The shared Postgres has no backups",
      restorePoints: [],
      checkedAt,
    },
  };
}

// The current cluster's volumes as protected by its backups, for the
// backup posture. Nothing while backups are off: those volumes then show
// as unprotected, which they are.
export function createBackupSource(
  load: () => Promise<{ snapshot: Snapshot; state: BackupState; pvcs: Pvc[] }>
): BackupSource {
  return {
    id: "postgres",
    label: "Shared Postgres",
    async list() {
      const { snapshot, state, pvcs } = await load();
      if (snapshot.absent) return "absent";
      const { view, intervalMs } = state;
      if (view.method === "none" || !snapshot.current) return [];
      const lastGoodAt =
        view.method === "pitr" ? view.lastBaseBackup : view.lastDump?.ok ? view.lastDump.at : undefined;
      const lastGoodRef = view.restorePoints.find((p) => p.state === "completed")?.id ?? "";
      const lastAttempt = view.restorePoints.find((p) => p.state !== "running");
      const description =
        view.method === "pitr"
          ? `Postgres base backups (${view.schedule ?? "?"}) and WAL archive to ${view.targetName ?? view.destination ?? "object storage"}`
          : `Postgres dumps (${view.schedule ?? "?"}) onto ${view.destination ?? "a Longhorn volume"}`;
      return pvcs
        .filter((p) => p.metadata.uid)
        .map((p): ProtectedVolume => ({
          pvc: { namespace: p.metadata.namespace ?? POSTGRES_NAMESPACE, name: p.metadata.name, uid: p.metadata.uid! },
          sourceId: "postgres",
          policy: {
            description,
            expectedEveryMs: intervalMs,
            // A dump reaches the target only with Longhorn's next backup of its volume.
            certainty: view.method === "pitr" ? "certain" : "probable",
          },
          ...(lastGoodAt ? { lastGood: { at: lastGoodAt, ref: lastGoodRef } } : {}),
          ...(lastAttempt
            ? {
                lastAttempt: {
                  at: lastAttempt.at,
                  ok: lastAttempt.state === "completed",
                  ...(lastAttempt.message ? { message: lastAttempt.message } : {}),
                },
              }
            : {}),
          target: {
            id: `postgres:${view.destination ?? view.method}`,
            label: view.targetName ?? view.destination ?? view.method,
            ...(view.destination ? { url: view.destination } : {}),
          },
        }));
    },
  };
}

export async function clusterPvcs(k8s: K8sApi, cluster: string): Promise<Pvc[]> {
  const listed = await k8s.list<Pvc>(RESOURCES.pvcs, {
    namespace: POSTGRES_NAMESPACE,
    labelSelector: `cnpg.io/cluster=${cluster}`,
  });
  return listed === "absent" ? [] : listed;
}

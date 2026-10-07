import type { BackupSource, ProtectedVolume } from "../../contracts/backups.js";
import {
  backupError,
  backupTime,
  historyOf,
  isBackupJob,
  jobName,
  jobsFor,
  lastGoodAt,
  pvcOf,
  scheduleOf,
  targetId,
  targetOf,
  targetsOf,
  time,
  type Load,
  type Snapshot,
} from "./model.js";

export const SOURCE_ID = "longhorn";

const iso = (ms: number) => new Date(ms).toISOString();

// A restored volume's fromBackup URL names the volume it came from
// ("…?backup=backup-x&volume=pvc-y"), which is where the evidence belongs:
// it proves that volume's backups restore.
function restoreEvidence(snapshot: Snapshot): Map<string, { at: number; ref: string }> {
  const byVolume = new Map<string, { at: number; ref: string }>();
  for (const restored of snapshot.volumes) {
    const from = restored.spec?.fromBackup;
    if (!from) continue;
    let source: string | null = null;
    try {
      source = new URL(from).searchParams.get("volume");
    } catch {
      continue;
    }
    const at = time(restored.metadata.creationTimestamp);
    if (!source || at === undefined) continue;
    const prior = byVolume.get(source);
    if (!prior || at > prior.at) byVolume.set(source, { at, ref: restored.metadata.name });
  }
  return byVolume;
}

export function protectedVolumes(snapshot: Snapshot, now: number): ProtectedVolume[] {
  const targets = targetsOf(snapshot);
  const evidence = restoreEvidence(snapshot);
  const out: ProtectedVolume[] = [];
  for (const volume of snapshot.volumes) {
    const pvc = pvcOf(volume);
    if (!pvc) continue;
    const jobs = jobsFor(volume, snapshot.jobs).filter(isBackupJob);
    if (!jobs.length) continue;

    const schedules = jobs.map((j) => scheduleOf(j, now));
    const everies = schedules.flatMap((s) => (s.expectedEveryMs === undefined ? [] : [s.expectedEveryMs]));
    const history = historyOf(volume, snapshot.backups);
    const good = lastGoodAt(history);
    const attempt = history.lastFinished;
    const target = targetOf(volume, targets);
    const restored = evidence.get(volume.metadata.name);
    const error = attempt ? backupError(attempt) : undefined;

    out.push({
      pvc: { ...pvc, uid: snapshot.pvcUids.get(`${pvc.namespace}/${pvc.name}`) ?? "" },
      sourceId: SOURCE_ID,
      policy: {
        description: `Longhorn recurring job${jobs.length === 1 ? "" : "s"} ${jobs
          .map((j) => `${jobName(j)} (${j.spec?.cron ?? "?"})`)
          .join(", ")}`,
        // With several jobs the most frequent one sets the expectation.
        ...(everies.length ? { expectedEveryMs: Math.min(...everies) } : {}),
        certainty: "certain",
      },
      ...(good ? { lastGood: { at: iso(good.at), ref: good.ref } } : {}),
      ...(attempt
        ? {
            lastAttempt: {
              at: iso(backupTime(attempt)),
              ok: attempt.status?.state === "Completed",
              ...(error ? { message: error } : {}),
            },
          }
        : {}),
      target: target
        ? { id: targetId(target), label: target.url || target.name, ...(target.url ? { url: target.url } : {}) }
        : { id: "longhorn:none", label: "No backup target configured" },
      ...(restored ? { restoreEvidence: { at: iso(restored.at), ref: restored.ref, kind: "volume-from-backup" } } : {}),
    });
  }
  return out.toSorted((a, b) => `${a.pvc.namespace}/${a.pvc.name}`.localeCompare(`${b.pvc.namespace}/${b.pvc.name}`));
}

export function createBackupSource(load: Load, now: () => number): BackupSource {
  return {
    id: SOURCE_ID,
    label: "Longhorn",
    async list() {
      const snapshot = await load();
      return snapshot === "absent" ? "absent" : protectedVolumes(snapshot, now());
    },
  };
}

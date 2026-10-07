import type { BackupSource, ProtectedVolume } from "../../contracts/backups.js";
import type { K8sApi } from "../../contracts/k8s.js";
import { expectedEveryMs, parseSchedule } from "./cron.js";
import {
  backupSchedule,
  finishedAt,
  isTerminal,
  keepsPvcs,
  locationName,
  locationTarget,
  matchesSelector,
  namespaceIncluded,
  newestFirst,
  problem,
  startedAt,
  type BackupSpecFields,
  type VeleroBackup,
  type VeleroRestore,
  type VeleroSchedule,
} from "./objects.js";
import { readClaims, readVelero, type PodObject, type PvcObject, type VeleroState } from "./state.js";

export const FS_BACKUP_INCLUDE = "backup.velero.io/backup-volumes";
export const FS_BACKUP_EXCLUDE = "backup.velero.io/backup-volumes-excludes";

export interface Coverage {
  method: "fs-backup" | "snapshot";
  certainty: "certain" | "probable";
  // Why coverage is only probable.
  doubts: string[];
}

const listed = (annotation: string | undefined, volume: string) =>
  (annotation ?? "")
    .split(",")
    .map((v) => v.trim())
    .includes(volume);

// A schedule is live when Velero will keep creating backups from it.
export const isLive = (s: VeleroSchedule) => !s.spec?.paused && s.status?.phase !== "FailedValidation";

// Whether a backup made from `spec` carries this PVC's data, and how sure
// that answer is. Velero decides per object at backup time from namespace,
// resource and label filters, pod annotations and volume policies; what
// can't be resolved from here makes the answer "probable", never "certain".
export function coverageOf(
  pvc: PvcObject,
  pods: PodObject[],
  spec: BackupSpecFields,
  // The schedule's latest backup: the server's fs-backup default shows up in
  // its spec when the template leaves it unset.
  latest?: VeleroBackup
): Coverage | undefined {
  const ns = pvc.metadata.namespace ?? "";
  if (!namespaceIncluded(ns, spec) || !keepsPvcs(spec)) return undefined;

  const mounts = pods
    .filter((p) => p.metadata.namespace === ns && p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed")
    .flatMap((pod) =>
      (pod.spec?.volumes ?? [])
        .filter((v) => v.persistentVolumeClaim?.claimName === pvc.metadata.name)
        .map((v) => ({ pod, volume: v.name }))
    );

  const doubts: string[] = [];
  const selectors = spec.orLabelSelectors?.length
    ? spec.orLabelSelectors
    : spec.labelSelector
      ? [spec.labelSelector]
      : [];
  if (selectors.length) {
    const selected = (labels: Record<string, string> | undefined) => selectors.some((s) => matchesSelector(labels, s));
    // A selected pod pulls in its claims whatever their own labels.
    if (!selected(pvc.metadata.labels) && !mounts.some((m) => selected(m.pod.metadata.labels))) return undefined;
    doubts.push("selected by label");
  }
  if (spec.resourcePolicy?.name) doubts.push(`volume policy ${spec.resourcePolicy.name} may skip it`);

  const fsDefault = spec.defaultVolumesToFsBackup ?? latest?.spec?.defaultVolumesToFsBackup ?? false;
  const fs = mounts.some(({ pod, volume }) =>
    fsDefault
      ? !listed(pod.metadata.annotations?.[FS_BACKUP_EXCLUDE], volume)
      : listed(pod.metadata.annotations?.[FS_BACKUP_INCLUDE], volume)
  );
  if (fs) return { method: "fs-backup", certainty: doubts.length ? "probable" : "certain", doubts };

  if (spec.snapshotVolumes === false) return undefined;
  doubts.push("relies on a volume snapshot this console cannot verify");
  return { method: "snapshot", certainty: "probable", doubts };
}

export function scheduleBackups(state: VeleroState, schedule: VeleroSchedule): VeleroBackup[] {
  const names = state.schedules.map((s) => s.metadata.name);
  return newestFirst(
    state.backups.filter(
      (b) => b.metadata.namespace === schedule.metadata.namespace && backupSchedule(b, names) === schedule.metadata.name
    )
  );
}

// Whether a restore brought back this namespace's claims from this schedule.
function restoredFrom(state: VeleroState, restore: VeleroRestore, schedule: VeleroSchedule, ns: string): boolean {
  const spec = restore.spec ?? {};
  if (!namespaceIncluded(ns, spec) || !keepsPvcs(spec)) return false;
  const source = state.backups.find(
    (b) => b.metadata.name === spec.backupName && b.metadata.namespace === restore.metadata.namespace
  );
  if (source) return namespaceIncluded(ns, source.spec ?? {}) && keepsPvcs(source.spec ?? {});
  // The backup has expired; its name still says which schedule made it.
  const names = state.schedules.map((s) => s.metadata.name);
  const from =
    spec.scheduleName ?? (spec.backupName ? backupSchedule({ metadata: { name: spec.backupName } }, names) : undefined);
  return from === schedule.metadata.name;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function protectedVolumes(
  state: VeleroState,
  pvcs: PvcObject[],
  pods: PodObject[],
  now: number
): ProtectedVolume[] {
  const out: ProtectedVolume[] = [];
  const restores = newestFirst(state.restores.filter((r) => r.status?.phase === "Completed"));
  for (const schedule of state.schedules.filter(isLive)) {
    const template = schedule.spec?.template ?? {};
    const backups = scheduleBackups(state, schedule);
    const expr = schedule.spec?.schedule ?? "";
    let everyMs: number | undefined;
    try {
      everyMs = expectedEveryMs(parseSchedule(expr), now);
    } catch {
      everyMs = undefined;
    }
    const location = locationName(template, state.locations) ?? "default";
    const target = locationTarget(
      location,
      state.locations.find((l) => l.metadata.name === location && l.metadata.namespace === schedule.metadata.namespace)
    );

    for (const pvc of pvcs) {
      const coverage = coverageOf(pvc, pods, template, backups[0]);
      if (!coverage) continue;
      const ns = pvc.metadata.namespace ?? "";
      const mine = backups.filter((b) => namespaceIncluded(ns, b.spec ?? {}) && keepsPvcs(b.spec ?? {}));
      const good = mine.find((b) => b.status?.phase === "Completed");
      const attempt = mine.find((b) => isTerminal(b.status?.phase));
      const restore = restores.find((r) => restoredFrom(state, r, schedule, ns));
      const how = coverage.method === "fs-backup" ? "file system backup" : "volume snapshot";
      const doubts = coverage.doubts.length ? `; ${coverage.doubts.join("; ")}` : "";
      const message = attempt ? problem(attempt) : undefined;
      out.push({
        pvc: { namespace: ns, name: pvc.metadata.name, uid: pvc.metadata.uid ?? "" },
        sourceId: "velero",
        policy: {
          description: `Velero schedule ${schedule.metadata.name} (${expr}), ${how}${doubts}`,
          ...(everyMs ? { expectedEveryMs: everyMs } : {}),
          certainty: coverage.certainty,
        },
        ...(good ? { lastGood: { at: iso(startedAt(good)), ref: good.metadata.name } } : {}),
        ...(attempt
          ? {
              lastAttempt: {
                at: iso(startedAt(attempt)),
                ok: attempt.status?.phase === "Completed",
                ...(message ? { message } : {}),
              },
            }
          : {}),
        target,
        ...(restore
          ? {
              restoreEvidence: {
                at: iso(finishedAt(restore)),
                ref: restore.metadata.name,
                kind: "restore-object" as const,
              },
            }
          : {}),
      });
    }
  }
  return out;
}

export function veleroBackupSource(getK8s: () => K8sApi, now: () => number = Date.now): BackupSource {
  return {
    id: "velero",
    label: "Velero",
    async list() {
      const k8s = getK8s();
      const state = await readVelero(k8s);
      if (state === "absent") return "absent";
      const { pvcs, pods } = await readClaims(k8s);
      return protectedVolumes(state, pvcs, pods, now());
    },
  };
}

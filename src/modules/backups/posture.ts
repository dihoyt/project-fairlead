import { STATUS_SEVERITY, type Status } from "../../contracts/health.js";
import type {
  BackupPosture,
  BackupTarget,
  PostureRow,
  ProtectedVolume,
  RestoreTestMark,
} from "../../contracts/backups.js";
import type { ClusterPvc } from "./cluster.js";
import type { PostureOptions } from "./settings.js";

export interface SourceOutcome {
  id: string;
  label: string;
  result: { state: "ok"; volumes: ProtectedVolume[] } | { state: "absent" } | { state: "error"; error: string };
}

export interface PostureInput {
  pvcs: ClusterPvc[];
  sources: SourceOutcome[];
  // By target id; missing when no capacity source matched or it failed.
  capacity: Map<string, { free: number; total: number }>;
  marks: Map<string, RestoreTestMark>;
  now: number;
  options: PostureOptions;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

export function duration(ms: number): string {
  if (ms < HOUR) return plural(Math.max(0, Math.round(ms / MINUTE)), "minute");
  if (ms < 2 * DAY) return plural(Math.round(ms / HOUR), "hour");
  return plural(Math.round(ms / DAY), "day");
}

export function policyPhrase(everyMs: number): string {
  if (everyMs === HOUR) return "an hourly policy";
  if (everyMs === DAY) return "a daily policy";
  if (everyMs === 7 * DAY) return "a weekly policy";
  return `a policy of every ${duration(everyMs)}`;
}

const rank = (status: Status) => STATUS_SEVERITY.indexOf(status);
const worse = (a: Status, b: Status) => (rank(a) <= rank(b) ? a : b);

export function worst(statuses: Iterable<Status>, empty: Status = "absent"): Status {
  let result: Status | undefined;
  for (const status of statuses) result = result === undefined ? status : worse(result, status);
  return result ?? empty;
}

export interface Judgement {
  status: Status;
  detail: string;
  ageMs?: number;
}

// One source's coverage of one PVC, against its own policy.
export function judge(volume: ProtectedVolume, now: number, options: PostureOptions): Judgement {
  const { lastGood, lastAttempt } = volume;
  const goodAt = lastGood ? Date.parse(lastGood.at) : undefined;
  if (lastAttempt && !lastAttempt.ok && (goodAt === undefined || Date.parse(lastAttempt.at) >= goodAt)) {
    return {
      status: "crit",
      detail: `Last attempt failed: ${lastAttempt.message ?? "no reason given"}`,
      ...(goodAt !== undefined ? { ageMs: now - goodAt } : {}),
    };
  }
  if (goodAt === undefined || Number.isNaN(goodAt)) return { status: "warn", detail: "Covered, never backed up yet" };

  const ageMs = Math.max(0, now - goodAt);
  const every = volume.policy.expectedEveryMs;
  if (!every) return { status: "ok", detail: `${duration(ageMs)} old (the policy sets no interval)`, ageMs };
  const status: Status =
    ageMs > every * options.critFactor ? "crit" : ageMs > every * options.warnFactor ? "warn" : "ok";
  return { status, detail: `${duration(ageMs)} old against ${policyPhrase(every)}`, ageMs };
}

export function isIgnored(pvc: { namespace: string; name: string }, ignore: readonly string[]): boolean {
  return ignore.some((entry) => entry === pvc.namespace || entry === `${pvc.namespace}/${pvc.name}`);
}

// Namespace and name always, and the uid too when both sides have one, so a
// claim deleted and recreated under the same name is not credited with the
// old claim's backups.
function matches(volume: ProtectedVolume, pvc: ClusterPvc): boolean {
  if (volume.pvc.namespace !== pvc.ref.namespace || volume.pvc.name !== pvc.ref.name) return false;
  return !volume.pvc.uid || !pvc.ref.uid || volume.pvc.uid === pvc.ref.uid;
}

const newer = <T extends { at: string }>(a: T | undefined, b: T | undefined): T | undefined =>
  !a ? b : !b ? a : Date.parse(b.at) > Date.parse(a.at) ? b : a;

function rowFor(pvc: ClusterPvc, input: PostureInput, failedSources: string[]): PostureRow {
  const { options, now } = input;
  const coverage = input.sources.flatMap((s) =>
    s.result.state === "ok" ? s.result.volumes.filter((v) => matches(v, pvc)) : []
  );
  const base = {
    pvc: {
      ...pvc.ref,
      ...(pvc.sizeBytes !== undefined ? { sizeBytes: pvc.sizeBytes } : {}),
      ...(pvc.storageClass ? { storageClass: pvc.storageClass } : {}),
    },
    ...(pvc.app ? { app: pvc.app } : {}),
    coverage,
    protected: coverage.length > 0,
  };
  const mark = input.marks.get(pvc.ref.uid);
  const manual = mark ? { at: mark.at, from: "manual" as const, ...(mark.note ? { note: mark.note } : {}) } : undefined;

  if (coverage.length === 0) {
    let ageStatus: Status = "crit";
    let ageDetail = "Not covered by any backup";
    if (isIgnored(pvc.ref, options.ignore)) {
      ageStatus = "absent";
      ageDetail = "Not covered by any backup; ignored in settings";
    } else if (pvc.ownData) {
      // Judging the console's own volume would make every fresh install
      // critical by default; it is recovered with the release, not here.
      ageStatus = "absent";
      ageDetail = "This console's own data volume; it is recovered with its release, so it is not judged here";
    } else if (failedSources.length > 0) {
      ageStatus = "unknown";
      ageDetail = `Not covered by any source that answered; ${failedSources.join(", ")} could not be read`;
    } else if (pvc.nfs) {
      ageStatus = "warn";
      ageDetail = "No backup the cluster can see; on NFS, so backups may exist on the storage server";
    }
    return { ...base, ageStatus, ageDetail, ...(manual ? { restoreTested: manual } : {}), status: ageStatus };
  }

  // A PVC two sources cover is as recoverable as its best copy; the other
  // source's trouble is that source's own health check.
  const judged = coverage
    .map((volume) => ({ volume, ...judge(volume, now, options) }))
    .toSorted(
      (a, b) =>
        rank(b.status) - rank(a.status) ||
        (Date.parse(b.volume.lastGood?.at ?? "") || 0) - (Date.parse(a.volume.lastGood?.at ?? "") || 0)
    );
  const best = judged[0]!;

  let lastGood: PostureRow["lastGood"];
  for (const v of coverage) {
    if (v.lastGood && (!lastGood || Date.parse(v.lastGood.at) > Date.parse(lastGood.at))) {
      lastGood = { ...v.lastGood, sourceId: v.sourceId };
    }
  }

  const target: BackupTarget & { free?: number; total?: number } = { ...best.volume.target };
  const space = input.capacity.get(target.id);
  if (space) Object.assign(target, space);

  let status = best.status;
  if (space && options.targetFreeWarnPercent > 0 && space.total > 0) {
    if ((space.free / space.total) * 100 < options.targetFreeWarnPercent) status = worse(status, "warn");
  }

  let evidence: PostureRow["restoreTested"];
  for (const v of coverage) {
    if (!v.restoreEvidence) continue;
    const candidate = { at: v.restoreEvidence.at, from: "evidence" as const, ref: v.restoreEvidence.ref };
    evidence = newer(evidence, candidate);
  }
  const restoreTested = newer(evidence, manual);

  return {
    ...base,
    ...(lastGood ? { lastGood } : {}),
    ageStatus: best.status,
    ageDetail: best.detail,
    target,
    ...(restoreTested ? { restoreTested } : {}),
    status,
  };
}

export function compareRows(a: PostureRow, b: PostureRow): number {
  return (
    Number(a.protected) - Number(b.protected) ||
    rank(a.status) - rank(b.status) ||
    a.pvc.namespace.localeCompare(b.pvc.namespace) ||
    a.pvc.name.localeCompare(b.pvc.name)
  );
}

export function buildPosture(input: PostureInput): BackupPosture {
  const failed = input.sources.filter((s) => s.result.state === "error").map((s) => s.id);
  const rows = input.pvcs.map((pvc) => rowFor(pvc, input, failed)).toSorted(compareRows);
  return {
    rows,
    sources: input.sources.map((s) => ({
      id: s.id,
      label: s.label,
      state: s.result.state,
      volumes: s.result.state === "ok" ? s.result.volumes.length : 0,
      ...(s.result.state === "error" ? { error: s.result.error } : {}),
    })),
    generatedAt: new Date(input.now).toISOString(),
  };
}

// The target of a row is the one that would be restored from, so it is also
// the one whose space is asked for.
export function targetsOf(sources: SourceOutcome[]): BackupTarget[] {
  const seen = new Map<string, BackupTarget>();
  for (const s of sources) {
    if (s.result.state !== "ok") continue;
    for (const v of s.result.volumes) if (!seen.has(v.target.id)) seen.set(v.target.id, v.target);
  }
  return [...seen.values()];
}

import type { CheckResult, HealthProvider, Status } from "../../contracts/health.js";
import { STATUS_SEVERITY } from "../../contracts/health.js";
import type { K8sApi } from "../../contracts/k8s.js";
import { coverageOf, isLive, scheduleBackups } from "./coverage.js";
import { expectedEveryMs, firesBetween, parseSchedule } from "./cron.js";
import {
  backupSchedule,
  finishedAt,
  isTerminal,
  locationName,
  locationUrl,
  newestFirst,
  phaseStatus,
  problem,
  startedAt,
  type VeleroLocation,
  type VeleroSchedule,
} from "./objects.js";
import { readClaims, readVelero, type VeleroState } from "./state.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// How far back a backup that came from no current schedule is still news.
const OTHER_BACKUPS_WINDOW_MS = 7 * DAY;

export interface VeleroRules {
  // A run is missed once its fire time is this far in the past with no backup.
  graceMs: number;
  // A completed restore older than this no longer counts as a tested restore.
  restoreMaxAgeMs: number;
}

const worst = (...statuses: Status[]): Status => STATUS_SEVERITY.find((s) => statuses.includes(s)) ?? "ok";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function ago(ms: number): string {
  if (ms < HOUR) return `${Math.max(0, Math.round(ms / MINUTE))}m ago`;
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)}h ago`;
  return `${Math.round(ms / DAY)}d ago`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const key = (o: { metadata: { namespace?: string; name: string } }) =>
  `${o.metadata.namespace ?? ""}/${o.metadata.name}`;

function locationChecks(state: VeleroState, observedAt: string, now: number): CheckResult[] {
  if (!state.locations.length) {
    return [
      {
        id: "locations",
        label: "Storage locations",
        status: "warn",
        detail: "No BackupStorageLocation is configured, so Velero has nowhere to write backups",
        observedAt,
      },
    ];
  }
  const inUse = new Set(
    state.schedules
      .filter(isLive)
      .map((s) => `${s.metadata.namespace ?? ""}/${locationName(s.spec?.template, state.locations) ?? ""}`)
  );
  return state.locations.map((loc: VeleroLocation) => {
    const name = loc.metadata.name;
    const url = locationUrl(loc);
    const phase = loc.status?.phase;
    const used = loc.spec?.default || inUse.has(key(loc));
    const validated = loc.status?.lastValidationTime ? Date.parse(loc.status.lastValidationTime) : NaN;
    const raw = {
      name,
      namespace: loc.metadata.namespace,
      phase,
      message: loc.status?.message,
      default: loc.spec?.default ?? false,
      provider: loc.spec?.provider,
      url,
      lastValidationTime: loc.status?.lastValidationTime,
      lastSyncedTime: loc.status?.lastSyncedTime,
    };
    const base = { id: `location:${key(loc)}`, label: `Storage location ${name}`, observedAt };
    if (phase === "Available") {
      return {
        ...base,
        status: "ok" as const,
        value: phase,
        detail: `Available${url ? ` at ${url}` : ""}${Number.isNaN(validated) ? "" : `, validated ${ago(now - validated)}`}`,
      };
    }
    if (phase === "Unavailable") {
      return {
        ...base,
        // A location nothing writes to is a loose end; one a schedule or
        // the default points at means backups are failing.
        status: used ? ("crit" as const) : ("warn" as const),
        value: phase,
        detail: loc.status?.message || `Unavailable${url ? ` at ${url}` : ""}`,
        raw,
      };
    }
    return {
      ...base,
      status: "unknown" as const,
      detail: phase ? `Phase ${phase}` : "Not validated by Velero yet",
      raw,
    };
  });
}

function scheduleCheck(schedule: VeleroSchedule, rules: VeleroRules, observedAt: string, now: number): CheckResult {
  const name = schedule.metadata.name;
  const expr = schedule.spec?.schedule ?? "";
  const base = { id: `schedule:${key(schedule)}`, label: `Schedule ${name}`, observedAt };
  const raw = { name, schedule: expr, paused: schedule.spec?.paused ?? false, status: schedule.status };
  if (schedule.status?.phase === "FailedValidation") {
    return {
      ...base,
      status: "crit",
      detail: `Failed validation: ${schedule.status.validationErrors?.join("; ") || "no reason given"}`,
      raw,
    };
  }
  if (schedule.spec?.paused) return { ...base, status: "warn", detail: `Paused (${expr})`, raw };
  let spec;
  try {
    spec = parseSchedule(expr);
  } catch (err) {
    return { ...base, status: "crit", detail: `Cannot read schedule "${expr}": ${message(err)}`, raw };
  }
  const lastRunIso = schedule.status?.lastBackup;
  const lastRun = Date.parse(lastRunIso ?? schedule.metadata.creationTimestamp ?? "");
  if (Number.isNaN(lastRun)) {
    return { ...base, status: "unknown", detail: `No last run or creation time recorded (${expr})`, raw };
  }
  const missed = firesBetween(spec, lastRun, now - rules.graceMs);
  const last = lastRunIso ? `last run ${ago(now - lastRun)}` : "never run";
  if (!missed.length) {
    return { ...base, status: "ok", value: 0, detail: `On schedule (${expr}), ${last}` };
  }
  const due = new Date(missed[missed.length - 1] ?? now).toISOString();
  return {
    ...base,
    status: missed.length >= 2 ? "crit" : "warn",
    value: missed.length,
    detail: `Missed ${missed.length >= 10 ? "10 or more runs" : plural(missed.length, "run")} (${expr}), ${last}; first missed run was due ${due}`,
    raw: { ...raw, missedRuns: missed.map((t) => new Date(t).toISOString()) },
  };
}

function lastBackupCheck(
  state: VeleroState,
  schedule: VeleroSchedule,
  rules: VeleroRules,
  observedAt: string,
  now: number
): CheckResult {
  const name = schedule.metadata.name;
  const base = { id: `backup:${key(schedule)}`, label: `Last backup ${name}`, observedAt };
  const backups = scheduleBackups(state, schedule);
  const latest = backups.find((b) => isTerminal(b.status?.phase));
  const running = backups[0] && !isTerminal(backups[0].status?.phase) ? backups[0] : undefined;
  const runningNote = running ? `; ${running.metadata.name} is ${running.status?.phase ?? "New"}` : "";
  if (!latest) {
    if (schedule.status?.lastBackup && !running) {
      return {
        ...base,
        status: "warn",
        detail: "No Backup objects left for this schedule; they were deleted or have expired",
        raw: { schedule: name, lastBackup: schedule.status.lastBackup },
      };
    }
    return { ...base, status: "ok", detail: `No backup has finished yet${runningNote}` };
  }
  const good = backups.find((b) => b.status?.phase === "Completed");
  const phase = latest.status?.phase;
  const phaseState = phaseStatus(phase);
  let ageState: Status = "ok";
  let every: number | undefined;
  try {
    every = expectedEveryMs(parseSchedule(schedule.spec?.schedule ?? ""), now);
  } catch {
    every = undefined;
  }
  const goodAge = good ? now - startedAt(good) : undefined;
  if (goodAge !== undefined && every) {
    if (goodAge > 2 * every + rules.graceMs) ageState = "crit";
    else if (goodAge > every + rules.graceMs) ageState = "warn";
  }
  const status = worst(phaseState, ageState);
  const reason = problem(latest);
  const lastGood = good
    ? good === latest
      ? ""
      : `; last completed ${good.metadata.name} ${ago(goodAge ?? 0)}`
    : "; no completed backup on record";
  return {
    ...base,
    status,
    ...(goodAge !== undefined ? { value: Math.round(goodAge / HOUR) } : {}),
    detail: `${latest.metadata.name} ${phase} ${ago(now - finishedAt(latest))}${reason ? ` (${reason})` : ""}${lastGood}${runningNote}`,
    ...(status === "ok"
      ? {}
      : {
          raw: {
            backup: latest.metadata.name,
            phase,
            status: latest.status,
            lastCompleted: good?.metadata.name,
            expectedEveryMs: every,
          },
        }),
  };
}

function otherBackupsCheck(state: VeleroState, observedAt: string, now: number): CheckResult | undefined {
  const names = state.schedules.map((s) => s.metadata.name);
  const others = newestFirst(
    state.backups.filter(
      (b) =>
        !names.includes(backupSchedule(b, names) ?? "") &&
        isTerminal(b.status?.phase) &&
        now - startedAt(b) <= OTHER_BACKUPS_WINDOW_MS
    )
  );
  if (!others.length) return undefined;
  const bad = others.filter((b) => b.status?.phase !== "Completed");
  return {
    id: "other-backups",
    label: "Other backups (7 days)",
    // Nothing repeats these, so a failure is worth seeing but not paging on.
    status: bad.length ? "warn" : "ok",
    value: bad.length,
    detail: bad.length
      ? `${plural(bad.length, "backup")} not from a current schedule did not complete: ${bad
          .map((b) => `${b.metadata.name} ${b.status?.phase}${problem(b) ? ` (${problem(b)})` : ""}`)
          .join("; ")}`
      : `${plural(others.length, "backup")} not from a current schedule, all completed`,
    ...(bad.length
      ? { raw: bad.map((b) => ({ backup: b.metadata.name, phase: b.status?.phase, status: b.status, spec: b.spec })) }
      : {}),
    observedAt,
  };
}

function restoreCheck(state: VeleroState, rules: VeleroRules, observedAt: string, now: number): CheckResult {
  const base = { id: "restore", label: "Last restore", observedAt };
  const restores = newestFirst(state.restores);
  const latest = restores.find((r) => isTerminal(r.status?.phase));
  const good = restores.find((r) => r.status?.phase === "Completed");
  const maxDays = Math.round(rules.restoreMaxAgeMs / DAY);
  if (!latest) {
    return {
      ...base,
      status: "warn",
      detail: "No Velero restore has been run, so no backup has been proven restorable",
    };
  }
  const goodAge = good ? now - finishedAt(good) : undefined;
  const ageState: Status = goodAge === undefined || goodAge > rules.restoreMaxAgeMs ? "warn" : "ok";
  const status = worst(phaseStatus(latest.status?.phase), ageState);
  const from = latest.spec?.backupName ? ` from ${latest.spec.backupName}` : "";
  const reason = problem(latest);
  const goodNote = good
    ? good === latest
      ? ""
      : `; last completed ${good.metadata.name} ${ago(goodAge ?? 0)}`
    : "; none has completed";
  const stale = good && ageState === "warn" ? `, older than ${maxDays} days` : "";
  return {
    ...base,
    status,
    ...(goodAge !== undefined ? { value: Math.round(goodAge / DAY) } : {}),
    detail: `${latest.metadata.name}${from} ${latest.status?.phase} ${ago(now - finishedAt(latest))}${reason ? ` (${reason})` : ""}${goodNote}${stale}`,
    ...(status === "ok" ? {} : { raw: { restore: latest.metadata.name, spec: latest.spec, status: latest.status } }),
  };
}

async function coverageCheck(k8s: K8sApi, state: VeleroState, observedAt: string): Promise<CheckResult | undefined> {
  const { pvcs, pods } = await readClaims(k8s);
  if (!pvcs.length) return undefined;
  const live = state.schedules.filter(isLive);
  const namespaces = [...new Set(pvcs.map((p) => p.metadata.namespace ?? ""))].toSorted();
  const covered = new Set<string>();
  for (const pvc of pvcs) {
    for (const s of live) {
      if (coverageOf(pvc, pods, s.spec?.template ?? {}, scheduleBackups(state, s)[0])) {
        covered.add(pvc.metadata.namespace ?? "");
        break;
      }
    }
  }
  const uncovered = namespaces.filter((ns) => !covered.has(ns));
  return {
    id: "coverage",
    label: "Namespaces with volumes",
    // Informational by default: another source may protect what Velero
    // doesn't, and the backup posture page judges that across sources. A
    // rule on the value (warnAbove: 0) makes it strict.
    status: "ok",
    value: uncovered.length,
    detail: uncovered.length
      ? `Schedules cover volumes in ${covered.size} of ${plural(namespaces.length, "namespace")}; not covered: ${uncovered.join(", ")}`
      : `Schedules cover volumes in all ${plural(namespaces.length, "namespace")}`,
    raw: { covered: [...covered].toSorted(), uncovered },
    observedAt,
  };
}

export function veleroHealthProvider(
  getK8s: () => K8sApi,
  rules: () => VeleroRules,
  now: () => number = Date.now
): HealthProvider {
  return {
    id: "velero",
    category: "backups",
    label: "Velero",
    intervalMs: 60_000,
    async collect(): Promise<CheckResult[]> {
      const at = now();
      const observedAt = new Date(at).toISOString();
      try {
        const k8s = getK8s();
        const state = await readVelero(k8s);
        if (state === "absent") {
          return [
            {
              id: "installed",
              label: "Velero",
              status: "absent",
              detail: "Velero CRDs are not installed in this cluster",
              observedAt,
            },
          ];
        }
        const r = rules();
        const results: CheckResult[] = [...locationChecks(state, observedAt, at)];
        if (!state.schedules.length) {
          results.push({
            id: "schedules",
            label: "Schedules",
            status: "warn",
            detail: "Velero is installed but has no schedules, so nothing is backed up automatically",
            observedAt,
          });
        }
        for (const schedule of state.schedules.toSorted((a, b) => key(a).localeCompare(key(b)))) {
          results.push(scheduleCheck(schedule, r, observedAt, at));
          results.push(lastBackupCheck(state, schedule, r, observedAt, at));
        }
        const other = otherBackupsCheck(state, observedAt, at);
        if (other) results.push(other);
        results.push(restoreCheck(state, r, observedAt, at));
        try {
          const coverage = await coverageCheck(k8s, state, observedAt);
          if (coverage) results.push(coverage);
        } catch (err) {
          results.push({
            id: "coverage",
            label: "Namespaces with volumes",
            status: "unknown",
            detail: `Could not read PVCs and pods: ${message(err)}`,
            raw: { error: message(err) },
            observedAt,
          });
        }
        return results;
      } catch (err) {
        return [
          {
            id: "api",
            label: "Velero",
            status: "unknown",
            detail: `Could not read Velero objects: ${message(err)}`,
            raw: { error: message(err) },
            observedAt,
          },
        ];
      }
    },
  };
}

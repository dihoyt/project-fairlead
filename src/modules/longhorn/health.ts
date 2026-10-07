import type { CheckResult, HealthProvider, Status } from "../../contracts/health.js";
import { errorMessage } from "../../runtime/log.js";
import { previousFires } from "./cron.js";
import {
  backupError,
  backupTime,
  historyOf,
  isBackupJob,
  jobName,
  isSnapshotJob,
  jobsFor,
  readable,
  replicasOf,
  snapshotJob,
  snapshotsOf,
  snapshotTime,
  lastGoodAt,
  missedRuns,
  scheduleOf,
  targetsOf,
  time,
  volumeLabel,
  volumesFor,
  type Load,
  type LonghornBackup,
  type LonghornNode,
  type LonghornReplica,
  type LonghornSnapshot,
  type LonghornVolume,
  type Snapshot,
} from "./model.js";

export const STORAGE_PROVIDER_ID = "longhorn";
export const BACKUPS_PROVIDER_ID = "longhorn.backups";

const HOUR = 3_600_000;

export interface HealthOptions {
  load: Load;
  now: () => number;
  // How long after a scheduled run its backup may still be missing.
  graceMs: () => number;
  // Longhorn UI base URL, "" when not configured.
  uiUrl: () => string;
}

// A pod in one of these states needs its volume attached.
const POD_WANTS_VOLUME = new Set(["Running", "Pending", "ContainerCreating"]);

function link(uiUrl: string, path: string): { deepLink?: string } {
  return uiUrl ? { deepLink: `${uiUrl.replace(/\/+$/, "")}/#/${path}` } : {};
}

function ago(ms: number): string {
  if (ms < HOUR) return `${Math.max(0, Math.round(ms / 60_000))}m`;
  if (ms < 48 * HOUR) return `${Math.round(ms / HOUR)}h`;
  return `${Math.round(ms / (24 * HOUR))}d`;
}

const iso = (ms: number) => new Date(ms).toISOString();

function absent(id: string, label: string, observedAt: string): CheckResult[] {
  return [{ id, label, status: "absent", detail: "Longhorn is not installed in this cluster", observedAt }];
}

function failed(id: string, label: string, err: unknown, observedAt: string): CheckResult[] {
  const message = errorMessage(err);
  return [
    {
      id,
      label,
      status: "unknown",
      detail: `Could not read Longhorn: ${message}`,
      raw: { error: message },
      observedAt,
    },
  ];
}

// --- storage: volume health ------------------------------------------------

// "1 of 2 replicas running; node-3 error since …", from Replica objects.
function replicaNote(volume: LonghornVolume, replicas: LonghornReplica[]): { running: number; note: string } {
  const desired = volume.spec?.numberOfReplicas;
  const mine = replicasOf(volume, replicas);
  const running = mine.filter((r) => r.status?.currentState === "running").length;
  const bad = mine
    .filter((r) => r.status?.currentState !== "running")
    .map((r) => {
      const since = time(r.spec?.failedAt);
      return `${r.spec?.nodeID || r.metadata.name} ${r.status?.currentState || "unknown"}${since === undefined ? "" : ` since ${iso(since)}`}`;
    });
  const of = desired === undefined ? `${running}` : `${running} of ${desired}`;
  return {
    running,
    note: `${of} replica${(desired ?? running) === 1 ? "" : "s"} running${bad.length ? ` (${bad.join(", ")})` : ""}`,
  };
}

export function volumeResult(
  volume: LonghornVolume,
  observedAt: string,
  uiUrl: string,
  replicas?: LonghornReplica[]
): CheckResult {
  const s = volume.status ?? {};
  const desired = volume.spec?.numberOfReplicas;
  const wanted = desired === undefined ? "" : `, ${desired} replica${desired === 1 ? "" : "s"} desired`;
  const where = s.state === "attached" && s.currentNodeID ? ` on ${s.currentNodeID}` : "";
  const scheduling = s.conditions?.find((c) => c.type === "Scheduled" && c.status === "False");
  const schedNote = scheduling
    ? `; replica scheduling failing (${scheduling.reason || scheduling.message || "no reason given"})`
    : "";
  const users = (s.kubernetesStatus?.workloadsStatus ?? []).filter((w) => POD_WANTS_VOLUME.has(w.podStatus ?? ""));

  let status: Status;
  let detail: string;
  switch (s.robustness) {
    case "healthy":
      status = "ok";
      detail = `Healthy, ${s.state ?? "unknown state"}${where}${wanted}`;
      break;
    case "degraded":
      status = "warn";
      detail = `Degraded: fewer than ${desired ?? "the desired"} healthy replicas${where}`;
      break;
    case "faulted":
      status = "crit";
      detail = `Faulted: no healthy replica, data unavailable${wanted}`;
      break;
    default:
      if (s.state === "detached") {
        status = "ok";
        detail = "Detached, not in use";
      } else {
        status = "unknown";
        detail = `Robustness ${s.robustness || "not reported"}, ${s.state ?? "unknown state"}`;
      }
  }
  // Robustness says nothing about a pod left waiting on a detached volume.
  if (s.state === "detached" && users.length) {
    status = "crit";
    detail = `Detached while ${users.map((u) => `${u.podName ?? "a pod"} (${u.podStatus})`).join(", ")} needs it`;
  }
  if (scheduling && status === "ok") status = "warn";
  // A detached volume's replicas are stopped by design; only count them when attached.
  // No Replica objects at all says nothing, rather than "none running".
  if (replicas && s.state === "attached" && replicasOf(volume, replicas).length) {
    const { running, note } = replicaNote(volume, replicas);
    detail += `; ${note}`;
    if (desired !== undefined && running < desired && status === "ok") status = "warn";
    if (running === 0 && status !== "crit") status = "crit";
  }
  detail += schedNote;

  return {
    id: `volume:${volume.metadata.name}`,
    label: `Volume ${volumeLabel(volume)}`,
    status,
    value: s.robustness || s.state || "unknown",
    detail,
    ...(status === "ok" ? {} : { raw: { metadata: volume.metadata, spec: volume.spec, status: volume.status } }),
    ...link(uiUrl, `volume/${volume.metadata.name}`),
    observedAt,
  };
}

// --- storage: node disks ----------------------------------------------------

const condTrue = (conds: Array<{ type?: string; status?: string }> | undefined, type: string) =>
  conds?.find((c) => c.type === type)?.status;

// Longhorn stops scheduling replicas onto a disk below this much free space.
export function minimalAvailablePercent(snapshot: Snapshot): number {
  const value = Number(
    snapshot.settings.find((s) => s.metadata.name === "storage-minimal-available-percentage")?.value
  );
  return Number.isFinite(value) && value >= 0 ? value : 25;
}

export function nodeResult(node: LonghornNode, minimal: number, observedAt: string, uiUrl: string): CheckResult {
  const st = node.status ?? {};
  const disks = Object.entries(st.diskStatus ?? {});
  let status: Status = "ok";
  const worse = (next: Status) => {
    if (next === "crit" || (next === "warn" && status === "ok")) status = next;
  };
  const notes: string[] = [];
  if (condTrue(st.conditions, "Ready") === "False") {
    worse("crit");
    notes.push("node not ready");
  } else if (condTrue(st.conditions, "Schedulable") === "False" || node.spec?.allowScheduling === false) {
    worse("warn");
    notes.push("node not schedulable");
  }
  let lowest: number | undefined;
  for (const [name, disk] of disks) {
    const max = disk.storageMaximum ?? 0;
    const free = disk.storageAvailable ?? 0;
    const pct = max > 0 ? Math.round((free / max) * 1000) / 10 : 0;
    lowest = lowest === undefined ? pct : Math.min(lowest, pct);
    const diskNotes: string[] = [];
    if (condTrue(disk.conditions, "Ready") === "False") {
      worse("crit");
      diskNotes.push("not ready");
    }
    if (pct < minimal / 2) {
      worse("crit");
      diskNotes.push(`${pct}% free, under half the ${minimal}% minimum`);
    } else if (pct < minimal) {
      worse("warn");
      diskNotes.push(`${pct}% free, under the ${minimal}% minimum: no new replicas`);
    } else {
      diskNotes.push(`${pct}% free`);
    }
    notes.push(`${name} ${diskNotes.join(", ")}`);
  }
  if (!disks.length) {
    worse("warn");
    notes.push("no disks reported");
  }
  return {
    id: `node:${node.metadata.name}`,
    label: `Storage node ${node.metadata.name}`,
    status,
    ...(lowest === undefined ? {} : { value: lowest }),
    detail: notes.join("; "),
    ...(status === "ok" ? {} : { raw: { spec: node.spec, status: node.status } }),
    ...link(uiUrl, "node"),
    observedAt,
  };
}

function unreadable(id: string, label: string, error: string, observedAt: string): CheckResult {
  return {
    id,
    label,
    status: "unknown",
    detail: `Could not read: ${error}`,
    raw: { error },
    observedAt,
  };
}

export function snapshotErrorsResult(
  snapshots: LonghornSnapshot[],
  volumes: LonghornVolume[],
  observedAt: string
): CheckResult {
  const live = snapshots.filter((s) => !s.status?.markRemoved);
  const failing = live.filter((s) => s.status?.error);
  const volumeOf = (snap: LonghornSnapshot) => {
    const v = volumes.find((x) => snapshotsOf(x, [snap]).length);
    return v ? volumeLabel(v) : (snap.spec?.volume ?? "unknown volume");
  };
  return {
    id: "snapshots",
    label: "Snapshots",
    status: failing.length ? "warn" : "ok",
    value: failing.length,
    detail: failing.length
      ? `${failing.length} snapshot${failing.length === 1 ? "" : "s"} failed: ${failing
          .map((s) => `${s.metadata.name} of ${volumeOf(s)}: ${s.status?.error}`)
          .join("; ")}`
      : `${live.length} snapshot${live.length === 1 ? "" : "s"}, none failed`,
    ...(failing.length ? { raw: failing.map((s) => ({ name: s.metadata.name, spec: s.spec, status: s.status })) } : {}),
    observedAt,
  };
}

export function storageResults(snapshot: Snapshot, observedAt: string, uiUrl: string): CheckResult[] {
  const results: CheckResult[] = [];
  const replicas = readable(snapshot.replicas);
  if (!snapshot.volumes.length) {
    results.push({
      id: "volumes",
      label: "Volumes",
      status: "ok",
      value: 0,
      detail: "No Longhorn volumes",
      observedAt,
    });
  }
  for (const v of snapshot.volumes.toSorted((a, b) => volumeLabel(a).localeCompare(volumeLabel(b)))) {
    results.push(volumeResult(v, observedAt, uiUrl, replicas));
  }
  if (!Array.isArray(snapshot.replicas)) {
    results.push(unreadable("replicas", "Replica counts", snapshot.replicas.error, observedAt));
  }

  if (Array.isArray(snapshot.nodes)) {
    const minimal = minimalAvailablePercent(snapshot);
    for (const node of snapshot.nodes.toSorted((a, b) => a.metadata.name.localeCompare(b.metadata.name))) {
      results.push(nodeResult(node, minimal, observedAt, uiUrl));
    }
  } else {
    results.push(unreadable("nodes", "Storage nodes", snapshot.nodes.error, observedAt));
  }

  results.push(
    Array.isArray(snapshot.snapshots)
      ? snapshotErrorsResult(snapshot.snapshots, snapshot.volumes, observedAt)
      : unreadable("snapshots", "Snapshots", snapshot.snapshots.error, observedAt)
  );
  return results;
}

export function createStorageProvider(options: HealthOptions): HealthProvider {
  return {
    id: STORAGE_PROVIDER_ID,
    category: "storage",
    label: "Longhorn volumes",
    intervalMs: 60_000,
    async collect() {
      const observedAt = iso(options.now());
      try {
        const snapshot = await options.load();
        if (snapshot === "absent") return absent("installed", "Longhorn", observedAt);
        return storageResults(snapshot, observedAt, options.uiUrl());
      } catch (err) {
        return failed("volumes", "Volumes", err, observedAt);
      }
    },
  };
}

// --- backups: targets, jobs, per-volume backup age ---------------------------

function judgeMissed(missed: number): Status {
  return missed >= 2 ? "crit" : missed === 1 ? "warn" : "ok";
}

export function backupResults(snapshot: Snapshot, now: number, graceMs: number, uiUrl: string): CheckResult[] {
  const observedAt = iso(now);
  const results: CheckResult[] = [];

  const targets = targetsOf(snapshot);
  if (!targets.length) {
    results.push({
      id: "target",
      label: "Backup target",
      status: snapshot.jobs.some(isBackupJob) ? "crit" : "warn",
      detail: "No backup target configured",
      observedAt,
      raw: { backupTargets: snapshot.targets.length, settings: snapshot.settings.map((s) => s.metadata.name) },
      ...link(uiUrl, "setting"),
    });
  }
  for (const t of targets) {
    const ok = t.available !== false;
    results.push({
      id: `target:${t.name}`,
      label: `Backup target ${t.name}`,
      status: t.available === undefined ? (t.url ? "unknown" : "warn") : ok ? "ok" : "crit",
      detail:
        t.available === undefined
          ? t.url
            ? `${t.url}: reachability not reported by this Longhorn version`
            : "No URL set"
          : ok
            ? `${t.url} reachable`
            : `${t.url} unreachable${t.message ? `: ${t.message}` : ""}`,
      ...(ok ? {} : { raw: snapshot.targets.find((x) => x.metadata.name === t.name) ?? t }),
      ...link(uiUrl, "backupTarget"),
      observedAt,
    });
  }

  const jobs = snapshot.jobs.toSorted((a, b) => jobName(a).localeCompare(jobName(b)));
  for (const job of jobs) {
    const name = jobName(job);
    const schedule = scheduleOf(job, now);
    const volumes = volumesFor(job, snapshot.volumes, snapshot.jobs);
    const base = {
      id: `job:${name}`,
      label: `Recurring job ${name}`,
      ...link(uiUrl, "recurringJob"),
      observedAt,
    };
    const cronText = job.spec?.cron ?? "";
    if (!schedule.cron) {
      results.push({
        ...base,
        status: "warn",
        detail: `Cron "${cronText}" could not be read, so missed runs can't be judged`,
        raw: job,
      });
      continue;
    }
    const snapshots = readable(snapshot.snapshots);
    if (isSnapshotJob(job) && snapshots && volumes.length) {
      const latest = snapshots
        .filter((x) => snapshotJob(x) === name)
        .toSorted((a, b) => snapshotTime(b) - snapshotTime(a))[0];
      const since = latest ? snapshotTime(latest) : (time(job.metadata.creationTimestamp) ?? 0);
      const { missed } = missedRuns([schedule], since, now, graceMs);
      const status = judgeMissed(missed);
      results.push({
        ...base,
        status,
        value: missed,
        detail:
          (latest ? `Last snapshot ${ago(now - snapshotTime(latest))} ago` : "No snapshot from it yet") +
          `, ${cronText} on ${volumes.length} volume${volumes.length === 1 ? "" : "s"}` +
          (missed ? `; ${missed >= 3 ? "3 or more" : missed} scheduled run${missed === 1 ? "" : "s"} missed` : ""),
        ...(status === "ok" ? {} : { raw: { job, latest: latest ?? null } }),
      });
      continue;
    }
    if (!isBackupJob(job)) {
      results.push({
        ...base,
        status: "ok",
        value: job.status?.executionCount ?? 0,
        detail: `${job.spec?.task ?? "unknown"} job, ${cronText}, ${volumes.length} volume${volumes.length === 1 ? "" : "s"}, ran ${job.status?.executionCount ?? 0} times`,
      });
      continue;
    }
    if (!volumes.length) {
      results.push({ ...base, status: "ok", value: 0, detail: `Backup job ${cronText} applies to no volumes` });
      continue;
    }
    const ran = snapshot.backups
      .filter((b) => b.spec?.labels?.["RecurringJob"] === name)
      .toSorted((a, b) => backupTime(b) - backupTime(a));
    const latest = ran[0];
    const since = latest ? backupTime(latest) : (time(job.metadata.creationTimestamp) ?? 0);
    const { missed, lastDue } = missedRuns([schedule], since, now, graceMs);
    const status = judgeMissed(missed);
    const failedLatest = latest?.status?.state === "Error";
    results.push({
      ...base,
      status: failedLatest && status === "ok" ? "warn" : status,
      value: missed,
      detail:
        (latest
          ? `Last ran ${ago(now - backupTime(latest))} ago (${latest.status?.state ?? "unknown"})`
          : "Has not run yet") +
        `, ${cronText} on ${volumes.length} volume${volumes.length === 1 ? "" : "s"}` +
        (missed ? `; ${missed >= 3 ? "3 or more" : missed} scheduled run${missed === 1 ? "" : "s"} missed` : "") +
        (lastDue && missed ? `, last due ${iso(lastDue)}` : ""),
      ...(status === "ok" && !failedLatest ? {} : { raw: { job, latest } }),
    });
  }

  const protectedCount = { covered: 0, unprotected: [] as string[] };
  for (const volume of snapshot.volumes.toSorted((a, b) => volumeLabel(a).localeCompare(volumeLabel(b)))) {
    const backupJobs = jobsFor(volume, snapshot.jobs).filter(isBackupJob);
    if (!backupJobs.length) {
      protectedCount.unprotected.push(volumeLabel(volume));
      continue;
    }
    protectedCount.covered++;
    results.push(
      volumeBackupResult(
        volume,
        backupJobs.map((j) => scheduleOf(j, now)),
        snapshot,
        now,
        graceMs,
        uiUrl
      )
    );
  }
  const unprotected = protectedCount.unprotected;
  results.push({
    id: "unprotected",
    label: "Volumes without a backup job",
    status: unprotected.length ? "warn" : "ok",
    value: unprotected.length,
    detail: unprotected.length
      ? `${unprotected.length} of ${snapshot.volumes.length} with no recurring backup job: ${unprotected.join(", ")}`
      : `All ${protectedCount.covered} volumes have a recurring backup job`,
    ...(unprotected.length ? { raw: unprotected } : {}),
    observedAt,
  });
  return results;
}

function volumeBackupResult(
  volume: LonghornVolume,
  schedules: ReturnType<typeof scheduleOf>[],
  snapshot: Snapshot,
  now: number,
  graceMs: number,
  uiUrl: string
): CheckResult {
  const history = historyOf(volume, snapshot.backups);
  const good = lastGoodAt(history);
  const jobCreated = Math.min(...schedules.map((s) => time(s.job.metadata.creationTimestamp) ?? now));
  const since = good?.at ?? Math.max(time(volume.metadata.creationTimestamp) ?? 0, jobCreated);
  const { missed } = missedRuns(schedules, since, now, graceMs);
  let status = judgeMissed(missed);
  const failedAttempt: LonghornBackup | undefined =
    history.lastFinished?.status?.state === "Error" && (!good || backupTime(history.lastFinished) > good.at)
      ? history.lastFinished
      : undefined;
  if (failedAttempt && status === "ok") status = "warn";

  const parts = [
    good ? `Last good backup ${ago(now - good.at)} ago (${good.ref})` : "Never backed up",
    `jobs ${schedules.map((s) => `${jobName(s.job)} (${s.job.spec?.cron ?? "?"})`).join(", ")}`,
  ];
  if (missed) parts.push(`${missed >= 3 ? "3 or more" : missed} scheduled backup${missed === 1 ? "" : "s"} missed`);
  if (failedAttempt) {
    parts.push(
      `last attempt ${ago(now - backupTime(failedAttempt))} ago failed: ${backupError(failedAttempt) ?? "no message"}`
    );
  }
  // Hours since the last good backup, so a rule can put its own threshold on it.
  const value = good ? Math.round(((now - good.at) / HOUR) * 10) / 10 : "never";
  return {
    id: `backup:${volume.metadata.name}`,
    label: `Backups of ${volumeLabel(volume)}`,
    status,
    value,
    detail: parts.join("; "),
    ...(status === "ok"
      ? {}
      : {
          raw: {
            volume: volume.metadata.name,
            lastGood: history.lastGood?.status ?? null,
            lastAttempt: failedAttempt?.status ?? history.lastFinished?.status ?? null,
            schedules: schedules.map((s) => ({ job: jobName(s.job), cron: s.job.spec?.cron })),
            lastDue: schedules.flatMap((s) => (s.cron ? previousFires(s.cron, now - graceMs, 1) : [])).map(iso),
          },
        }),
    ...link(uiUrl, `backup/${volume.metadata.name}`),
    observedAt: iso(now),
  };
}

export function createBackupsProvider(options: HealthOptions): HealthProvider {
  return {
    id: BACKUPS_PROVIDER_ID,
    category: "backups",
    label: "Longhorn backups",
    intervalMs: 60_000,
    async collect() {
      const now = options.now();
      try {
        const snapshot = await options.load();
        if (snapshot === "absent") return absent("installed", "Longhorn", iso(now));
        return backupResults(snapshot, now, options.graceMs(), options.uiUrl());
      } catch (err) {
        return failed("backups", "Backups", err, iso(now));
      }
    },
  };
}

import type { Database } from "better-sqlite3";
import type { CheckHistoryPoint, CheckResult, Status } from "../../contracts/health.js";
import type { Events } from "../../contracts/events.js";

type Change = Events["health.changed"];

interface ResultRow {
  provider_id: string;
  check_id: string;
  label: string;
  status: Status;
  value: string | null;
  detail: string;
  raw: string | null;
  deep_link: string | null;
  object: string | null;
  observed_at: string;
  changed_at: string;
}

interface RunRow {
  provider_id: string;
  last_run_at: string;
  last_error: string | null;
}

export interface ProviderRun {
  lastRunAt: string;
  lastError?: string;
}

// An unchanged check still gets a history point this often, so a long-stable
// check has recent evidence and a history query is never empty.
const HISTORY_HEARTBEAT_MS = 3_600_000;

const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value));
const parse = (text: string | null): unknown => (text === null ? undefined : JSON.parse(text));

function toResult(row: ResultRow): CheckResult {
  const result: CheckResult = {
    id: row.check_id,
    label: row.label,
    status: row.status,
    detail: row.detail,
    observedAt: row.observed_at,
  };
  const value = parse(row.value);
  if (typeof value === "number" || typeof value === "string") result.value = value;
  const raw = parse(row.raw);
  if (raw !== undefined) result.raw = raw;
  if (row.deep_link) result.deepLink = row.deep_link;
  const object = parse(row.object);
  if (object) result.object = object as NonNullable<CheckResult["object"]>;
  return result;
}

export function createStore(db: Database, orgId: string) {
  const selectProvider = db.prepare<[string, string], ResultRow>(
    "SELECT * FROM health_check_results WHERE org_id = ? AND provider_id = ? ORDER BY check_id"
  );
  const upsert = db.prepare(`
    INSERT INTO health_check_results
      (org_id, provider_id, check_id, label, status, value, detail, raw, deep_link, object, observed_at, changed_at)
    VALUES (@org, @provider, @check, @label, @status, @value, @detail, @raw, @deepLink, @object, @observedAt, @changedAt)
    ON CONFLICT (org_id, provider_id, check_id) DO UPDATE SET
      label = excluded.label, status = excluded.status, value = excluded.value, detail = excluded.detail,
      raw = excluded.raw, deep_link = excluded.deep_link, object = excluded.object, observed_at = excluded.observed_at,
      changed_at = excluded.changed_at
  `);
  const removeResult = db.prepare(
    "DELETE FROM health_check_results WHERE org_id = ? AND provider_id = ? AND check_id = ?"
  );
  const lastPoint = db.prepare<[string, string, string], { at: string; status: Status }>(
    "SELECT at, status FROM health_check_history WHERE org_id = ? AND provider_id = ? AND check_id = ? ORDER BY at DESC, id DESC LIMIT 1"
  );
  const addPoint = db.prepare(
    "INSERT INTO health_check_history (org_id, provider_id, check_id, at, status, detail) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const upsertRun = db.prepare(`
    INSERT INTO health_provider_runs (org_id, provider_id, last_run_at, last_error, run_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (org_id, provider_id) DO UPDATE SET
      last_run_at = excluded.last_run_at, last_error = excluded.last_error, run_by = excluded.run_by
  `);
  const selectRuns = db.prepare<[string], RunRow>(
    "SELECT provider_id, last_run_at, last_error FROM health_provider_runs WHERE org_id = ?"
  );
  const selectAll = db.prepare<[string], ResultRow>(
    "SELECT * FROM health_check_results WHERE org_id = ? ORDER BY provider_id, check_id"
  );
  const historyRange = db.prepare<[string, string, string, string, string], CheckHistoryPoint>(
    "SELECT at, status, detail FROM health_check_history WHERE org_id = ? AND provider_id = ? AND check_id = ? AND at >= ? AND at <= ? ORDER BY at, id"
  );
  const historyBefore = db.prepare<[string, string, string, string], CheckHistoryPoint>(
    "SELECT at, status, detail FROM health_check_history WHERE org_id = ? AND provider_id = ? AND check_id = ? AND at < ? ORDER BY at DESC, id DESC LIMIT 1"
  );
  const prune = db.prepare("DELETE FROM health_check_history WHERE org_id = ? AND at < ?");

  // IMMEDIATE takes the write lock before reading, so two pods recording the
  // same provider serialise: the second reads the first's status and sees no
  // change, and each change is emitted exactly once across pods.
  const record = db.transaction(
    (providerId: string, results: CheckResult[], at: string, runBy: string, error: string | undefined): Change[] => {
      const changes: Change[] = [];
      const previous = new Map(selectProvider.all(orgId, providerId).map((row) => [row.check_id, row]));
      const seen = new Set<string>();

      for (const result of results) {
        if (seen.has(result.id)) continue;
        seen.add(result.id);
        const before = previous.get(result.id);
        const changed = !before || before.status !== result.status;
        upsert.run({
          org: orgId,
          provider: providerId,
          check: result.id,
          label: result.label,
          status: result.status,
          value: json(result.value),
          detail: result.detail,
          raw: json(result.raw),
          deepLink: result.deepLink ?? null,
          object: json(result.object),
          observedAt: result.observedAt,
          changedAt: changed || !before ? at : before.changed_at,
        });
        const last = lastPoint.get(orgId, providerId, result.id);
        if (!last || last.status !== result.status || Date.parse(at) - Date.parse(last.at) >= HISTORY_HEARTBEAT_MS) {
          addPoint.run(orgId, providerId, result.id, at, result.status, result.detail);
        }
        // A check seen for the first time is a change only if it starts out
        // bad: a fresh install should not announce every healthy check.
        const from: Status = before?.status ?? "ok";
        if (from !== result.status && (before || (result.status !== "ok" && result.status !== "absent"))) {
          changes.push({
            providerId,
            checkId: result.id,
            label: result.label,
            from,
            to: result.status,
            detail: result.detail,
          });
        }
      }

      for (const [checkId, before] of previous) {
        if (seen.has(checkId)) continue;
        const detail = `No longer reported by ${providerId}`;
        removeResult.run(orgId, providerId, checkId);
        addPoint.run(orgId, providerId, checkId, at, "absent", detail);
        if (before.status !== "absent") {
          changes.push({ providerId, checkId, label: before.label, from: before.status, to: "absent", detail });
        }
      }

      upsertRun.run(orgId, providerId, at, error ?? null, runBy);
      return changes;
    }
  );

  return {
    record: (providerId: string, results: CheckResult[], at: string, runBy: string, error?: string) =>
      record.immediate(providerId, results, at, runBy, error),

    results(providerId: string): CheckResult[] {
      return selectProvider.all(orgId, providerId).map(toResult);
    },

    allResults(): Map<string, CheckResult[]> {
      const byProvider = new Map<string, CheckResult[]>();
      for (const row of selectAll.all(orgId)) {
        const list = byProvider.get(row.provider_id) ?? [];
        list.push(toResult(row));
        byProvider.set(row.provider_id, list);
      }
      return byProvider;
    },

    runs(): Map<string, ProviderRun> {
      return new Map(
        selectRuns
          .all(orgId)
          .map((row) => [
            row.provider_id,
            row.last_error === null
              ? { lastRunAt: row.last_run_at }
              : { lastRunAt: row.last_run_at, lastError: row.last_error },
          ])
      );
    },

    // The point in force at `from` (the last one before it) is included,
    // clamped to `from`, so a chart can draw the state the window opened in.
    history(providerId: string, checkId: string, from: string, to: string): CheckHistoryPoint[] {
      const inRange = historyRange.all(orgId, providerId, checkId, from, to);
      const before = historyBefore.get(orgId, providerId, checkId, from);
      return before ? [{ ...before, at: from }, ...inRange] : inRange;
    },

    prune(before: string): number {
      return prune.run(orgId, before).changes;
    },
  };
}

export type Store = ReturnType<typeof createStore>;

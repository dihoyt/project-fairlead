import type { Database } from "better-sqlite3";
import type { Sample, SeriesInfo, SeriesQuery, SeriesResult } from "../../contracts/metrics.js";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface Tier {
  table: "metrics_raw" | "metrics_5m" | "metrics_1h";
  // Bucket width; raw has none, collectors decide how dense it is.
  resolutionMs: number;
  retentionMs: number;
}

// Finest first.
export const TIERS: readonly Tier[] = [
  { table: "metrics_raw", resolutionMs: 0, retentionMs: DAY },
  { table: "metrics_5m", resolutionMs: 5 * MINUTE, retentionMs: 30 * DAY },
  { table: "metrics_1h", resolutionMs: HOUR, retentionMs: 365 * DAY },
];

const ROLLUPS = TIERS.filter((tier) => tier.resolutionMs > 0);
const LONGEST = TIERS[TIERS.length - 1]!;

// A range with no step is cut into about this many buckets, which puts 24h on
// the 5-minute rollups and 1h on raw samples.
export const AUTO_POINTS = 288;
// Whatever step is asked for, a result never has more points than this.
export const MAX_POINTS = 5_000;
// Samples further ahead than this are a broken clock, not data.
const MAX_FUTURE_MS = HOUR;

const SERIES_NAME = /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;

export interface MetricsStore {
  write(samples: Sample[]): { stored: number; dropped: number };
  query(query: SeriesQuery): SeriesResult[];
  listSeries(prefix?: string): SeriesInfo[];
  // Deletes what each tier no longer keeps, and series with nothing left.
  applyRetention(): { deleted: number };
  // Which tier and bucket width a query is answered from.
  plan(query: Pick<SeriesQuery, "from" | "to" | "stepMs">): { tier: Tier; stepMs: number };
}

export interface StoreOptions {
  orgId: string;
  now?: () => number;
}

// Label order must not make two series of one label set.
export function canonicalLabels(labels: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(labels).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  );
}

export function validSample(sample: Sample): boolean {
  if (typeof sample !== "object" || sample === null) return false;
  if (typeof sample.series !== "string" || !SERIES_NAME.test(sample.series)) return false;
  if (!Number.isFinite(sample.ts) || !Number.isFinite(sample.value)) return false;
  if (typeof sample.labels !== "object" || sample.labels === null || Array.isArray(sample.labels)) return false;
  return Object.values(sample.labels).every((value) => typeof value === "string");
}

export function createMetricsStore(db: Database, options: StoreOptions): MetricsStore {
  const { orgId } = options;
  const now = options.now ?? Date.now;

  const findSeries = db.prepare<[string, string, string], { id: number }>(
    "SELECT id FROM metrics_series WHERE org_id = ? AND series = ? AND labels = ?"
  );
  const insertSeries = db.prepare<[string, string, string, number, number]>(
    `INSERT INTO metrics_series (org_id, series, labels, first_ts, last_ts) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (org_id, series, labels) DO NOTHING`
  );
  const touchSeries = db.prepare<[number, number, number]>(
    "UPDATE metrics_series SET last_ts = MAX(last_ts, ?), first_ts = MIN(first_ts, ?) WHERE id = ?"
  );
  const insertRaw = db.prepare<[number, number, number, string]>(
    "INSERT INTO metrics_raw (series_id, ts, value, org_id) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING"
  );
  const upsertRollup = ROLLUPS.map((tier) =>
    db.prepare<[number, number, number, number, number, string]>(
      `INSERT INTO ${tier.table} (series_id, ts, count, sum, min, max, org_id) VALUES (?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT (series_id, ts) DO UPDATE SET
         count = count + 1, sum = sum + excluded.sum, min = MIN(min, excluded.min), max = MAX(max, excluded.max)`
    )
  );

  // Series ids never change once assigned; retention clears this when it
  // deletes series rows.
  const ids = new Map<string, number>();
  const seriesId = (series: string, labels: string, ts: number): number => {
    const key = `${series}\n${labels}`;
    const cached = ids.get(key);
    if (cached !== undefined) return cached;
    insertSeries.run(orgId, series, labels, ts, ts);
    const id = findSeries.get(orgId, series, labels)!.id;
    ids.set(key, id);
    return id;
  };

  const writeAll = db.transaction((samples: Sample[]) => {
    const at = now();
    const oldest = at - TIERS[0]!.retentionMs;
    let stored = 0;
    const spans = new Map<number, { first: number; last: number }>();
    for (const sample of samples) {
      if (!validSample(sample) || sample.ts < oldest || sample.ts > at + MAX_FUTURE_MS) continue;
      const ts = Math.trunc(sample.ts);
      const id = seriesId(sample.series, canonicalLabels(sample.labels), ts);
      // A sample seen before (a retried collection, the other pod during a
      // rollout) must not be counted into the rollups twice.
      if (insertRaw.run(id, ts, sample.value, orgId).changes === 0) continue;
      ROLLUPS.forEach((tier, i) => {
        upsertRollup[i]!.run(id, ts - (ts % tier.resolutionMs), sample.value, sample.value, sample.value, orgId);
      });
      const span = spans.get(id);
      if (span) {
        span.first = Math.min(span.first, ts);
        span.last = Math.max(span.last, ts);
      } else spans.set(id, { first: ts, last: ts });
      stored++;
    }
    for (const [id, span] of spans) touchSeries.run(span.last, span.first, id);
    return stored;
  });

  const plan: MetricsStore["plan"] = ({ from, to, stepMs }) => {
    const span = Math.max(to - from, 1);
    const step = Math.max(Math.floor(stepMs ?? span / AUTO_POINTS), Math.ceil(span / MAX_POINTS), 1);
    const age = now() - from;
    const covering = TIERS.filter((tier) => tier.retentionMs >= age);
    // The coarsest tier fine enough for the step, among those still holding
    // data back to `from`; else the finest that does, at its own resolution.
    const fitting = covering.filter((tier) => tier.resolutionMs <= step);
    const tier = fitting[fitting.length - 1] ?? covering[0] ?? LONGEST;
    return { tier, stepMs: Math.max(step, tier.resolutionMs) };
  };

  const query: MetricsStore["query"] = (q) => {
    const matches = (
      db
        .prepare<[string, string], { id: number; labels: string }>(
          "SELECT id, labels FROM metrics_series WHERE org_id = ? AND series = ? ORDER BY labels"
        )
        .all(orgId, q.series) as { id: number; labels: string }[]
    )
      .map((row) => ({ id: row.id, labels: JSON.parse(row.labels) as Record<string, string> }))
      .filter((row) => Object.entries(q.labels ?? {}).every(([key, value]) => row.labels[key] === value));
    if (matches.length === 0) return [];

    const { tier, stepMs } = plan(q);
    // A rollup bucket that starts before `from` still holds samples inside it.
    const lower = tier.resolutionMs > 0 ? q.from - (q.from % tier.resolutionMs) : q.from;
    const value = tier.resolutionMs > 0 ? "SUM(sum) / SUM(count)" : "AVG(value)";
    const points = db.prepare<[number, number, number, number, number], { b: number; v: number }>(
      `SELECT (ts / CAST(? AS INTEGER)) * ? AS b, ${value} AS v FROM ${tier.table}
       WHERE series_id = ? AND ts >= ? AND ts <= ? GROUP BY b ORDER BY b`
    );
    return matches.map((row) => ({
      series: q.series,
      labels: row.labels,
      points: points.all(stepMs, stepMs, row.id, lower, q.to).map((p) => [p.b, p.v] as [number, number]),
    }));
  };

  const listSeries: MetricsStore["listSeries"] = (prefix = "") => {
    const like = `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const rows = db
      .prepare<[string, string, number], { series: string; labels: string; first_ts: number; last_ts: number }>(
        `SELECT series, labels, first_ts, last_ts FROM metrics_series
         WHERE org_id = ? AND series LIKE ? ESCAPE '\\' AND last_ts >= ? ORDER BY series`
      )
      .all(orgId, like, now() - LONGEST.retentionMs);
    const bySeries = new Map<string, { keys: Set<string>; firstTs: number; lastTs: number }>();
    for (const row of rows) {
      const entry = bySeries.get(row.series) ?? { keys: new Set<string>(), firstTs: Infinity, lastTs: -Infinity };
      for (const key of Object.keys(JSON.parse(row.labels) as object)) entry.keys.add(key);
      entry.firstTs = Math.min(entry.firstTs, row.first_ts);
      entry.lastTs = Math.max(entry.lastTs, row.last_ts);
      bySeries.set(row.series, entry);
    }
    return [...bySeries].map(([series, entry]) => ({
      series,
      labelKeys: [...entry.keys].toSorted(),
      firstTs: entry.firstTs,
      lastTs: entry.lastTs,
    }));
  };

  const retain = db.transaction(() => {
    const at = now();
    let deleted = 0;
    for (const tier of TIERS) {
      deleted += db.prepare(`DELETE FROM ${tier.table} WHERE ts < ?`).run(at - tier.retentionMs).changes;
    }
    // Every stored sample is in the longest tier, so a series with no row
    // there has no data anywhere. The highest id is kept: SQLite hands out
    // max(id) + 1, so keeping it means no id is ever reused, and a pod still
    // caching a forgotten id cannot write into someone else's series.
    const gone = db
      .prepare(
        `DELETE FROM metrics_series WHERE org_id = ?
         AND id < (SELECT MAX(id) FROM metrics_series)
         AND NOT EXISTS (SELECT 1 FROM ${LONGEST.table} WHERE series_id = metrics_series.id)`
      )
      .run(orgId).changes;
    const floor = at - LONGEST.retentionMs;
    db.prepare("UPDATE metrics_series SET first_ts = ? WHERE org_id = ? AND first_ts < ?").run(floor, orgId, floor);
    if (gone > 0) ids.clear();
    return deleted;
  });

  return {
    write(samples) {
      const stored = samples.length === 0 ? 0 : writeAll(samples);
      return { stored, dropped: samples.length - stored };
    },
    query,
    listSeries,
    applyRetention: () => ({ deleted: retain() }),
    plan,
  };
}

import { z } from "zod";
import type { Module, ModuleContext } from "../../contracts/module.js";
import type { SeriesQuery } from "../../contracts/metrics.js";
import { HttpError } from "../../runtime/http.js";
import { migrations } from "./migrations.js";
import { createMetricsStore, DAY, HOUR, type MetricsStore } from "./store.js";

// A collector asking for a tighter loop than this gets this.
export const MIN_COLLECT_INTERVAL_MS = 5_000;
export const RETENTION_INTERVAL_MS = HOUR;
export const MAX_QUERIES = 50;
const MAX_RANGE_MS = 400 * DAY;

const seriesQuery = z
  .object({
    series: z.string().min(1).max(200),
    labels: z.record(z.string(), z.string()).optional(),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    stepMs: z.number().int().positive().optional(),
  })
  .refine((q) => q.from <= q.to, { message: "from must not be after to" })
  .refine((q) => q.to - q.from <= MAX_RANGE_MS, { message: "range is longer than 400 days" });

const queryParam = z.array(seriesQuery).min(1).max(MAX_QUERIES);

export function parseQueryParam(q: unknown): SeriesQuery[] {
  if (typeof q !== "string") throw new HttpError(400, "q must be a JSON-encoded array of series queries.");
  let json: unknown;
  try {
    json = JSON.parse(q);
  } catch {
    throw new HttpError(400, "q is not valid JSON.");
  }
  const parsed = queryParam.safeParse(json);
  if (!parsed.success) throw new HttpError(400, `Invalid q: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function registerMetrics(ctx: ModuleContext, store: MetricsStore): void {
  ctx.metrics.setSink((samples) => {
    const { dropped } = store.write(samples);
    if (dropped > 0) ctx.log.warn("Dropped metric samples", { dropped, of: samples.length });
  });

  ctx.metrics.subscribe((collector) => {
    ctx.scheduler.every(`collect:${collector.id}`, Math.max(collector.intervalMs, MIN_COLLECT_INTERVAL_MS), async () =>
      ctx.metrics.write(await collector.collect())
    );
  });

  ctx.scheduler.every("retention", RETENTION_INTERVAL_MS, () => store.applyRetention());

  ctx.route("GET /api/metrics/query", (req) => parseQueryParam(req.query.q).flatMap((q) => store.query(q)));
  ctx.route("GET /api/metrics/series", (req) => {
    const prefix = req.query.prefix;
    if (prefix !== undefined && typeof prefix !== "string") throw new HttpError(400, "prefix must be a string.");
    return store.listSeries(prefix);
  });
}

const mod: Module = {
  id: "metrics",
  milestone: "A",
  migrations,
  register(ctx) {
    registerMetrics(ctx, createMetricsStore(ctx.db, { orgId: ctx.orgId }));
  },
};

export default mod;

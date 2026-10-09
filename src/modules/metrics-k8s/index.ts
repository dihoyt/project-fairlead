import { z } from "zod";
import type { Module, ModuleContext } from "../../contracts/module.js";
import { HttpError } from "../../runtime/http.js";
import { DEFAULT_THRESHOLDS, judge, type Thresholds } from "./health.js";
import { migrations } from "./migrations.js";
import type { MetricsQuery } from "../../contracts/runtime.js";
import { toNodeRows } from "./rows.js";
import { createScraper, toSamples, type Scraper, type ScraperOptions } from "./scrape.js";

export const COLLECT_INTERVAL_MS = 30_000;
export const HEALTH_INTERVAL_MS = 60_000;

const percentSetting = z.number().min(1).max(100);

function declareThresholds(ctx: ModuleContext): () => Thresholds {
  const setting = (name: keyof Thresholds, label: string) =>
    ctx.settings.declare({
      key: `metrics-k8s.${name}`,
      label,
      schema: percentSetting,
      default: DEFAULT_THRESHOLDS[name],
    });
  const memoryWarn = setting("memoryWarnPercent", "Node memory warning (% of allocatable)");
  const memoryCrit = setting("memoryCritPercent", "Node memory critical (% of allocatable)");
  const diskWarn = setting("diskWarnPercent", "Node disk warning (% used)");
  const diskCrit = setting("diskCritPercent", "Node disk critical (% used)");
  return () => ({
    memoryWarnPercent: memoryWarn.get(),
    memoryCritPercent: memoryCrit.get(),
    diskWarnPercent: diskWarn.get(),
    diskCritPercent: diskCrit.get(),
  });
}

export function registerMetricsK8s(ctx: ModuleContext, options: ScraperOptions = {}): Scraper {
  const scraper = createScraper(() => ctx.services.get("k8s"), options);
  const now = options.now ?? Date.now;
  const thresholds = declareThresholds(ctx);

  ctx.metrics.addCollector({
    id: "metrics-k8s",
    intervalMs: COLLECT_INTERVAL_MS,
    async collect() {
      try {
        const snapshot = await scraper.scrape();
        if (snapshot.error) ctx.log.warn("Node usage not collected", { error: snapshot.error });
        return toSamples(snapshot);
      } catch (err) {
        ctx.log.error("Node usage collection failed", { error: String(err) });
        return [];
      }
    },
  });

  ctx.health.addProvider({
    id: "metrics-k8s",
    category: "cluster",
    label: "Node usage",
    intervalMs: HEALTH_INTERVAL_MS,
    // A read the collector made moments ago is as good as a new one.
    collect: async () => judge(await scraper.recent(COLLECT_INTERVAL_MS), thresholds()),
  });

  ctx.route("GET /api/metrics-k8s/nodes", async (req) => {
    const snapshot = await scraper.recent(COLLECT_INTERVAL_MS);
    if (snapshot.error) throw new HttpError(503, snapshot.error);
    // Hosts and stored history only add to the rows; without them the rows
    // still carry what the cluster says.
    const hosts = await ctx.call(req, "GET /api/hosts").catch(() => []);
    let metrics: MetricsQuery | undefined;
    try {
      metrics = ctx.services.get("metrics");
    } catch {
      metrics = undefined;
    }
    return toNodeRows(snapshot, { hosts, metrics, now: now() });
  });

  return scraper;
}

const mod: Module = {
  id: "metrics-k8s",
  milestone: "A",
  migrations,
  register(ctx) {
    registerMetricsK8s(ctx);
  },
};

export default mod;

import type { Module, ModuleContext } from "../../contracts/module.js";
import { HttpError } from "../../runtime/http.js";
import { createHealthProvider } from "./health.js";
import { migrations } from "./migrations.js";
import { clusterView, databaseViews, primaryPod, readSnapshot, type Snapshot } from "./read.js";
import { readStats } from "./stats.js";

export interface PostgresOptions {
  now?: () => Date;
  // The primary's metrics endpoint, for tests.
  fetch?: typeof fetch;
}

// Page loads and the health provider within this window share one read.
const CACHE_MS = 10_000;

export function register(ctx: ModuleContext, options: PostgresOptions = {}): void {
  const now = options.now ?? (() => new Date());
  const fetcher = options.fetch ?? fetch;
  let cached: { at: number; value: Promise<Snapshot> } | undefined;

  const load = (): Promise<Snapshot> => {
    if (!ctx.services.has("k8s")) return Promise.reject(new HttpError(503, "The Kubernetes API is not available."));
    const at = now().getTime();
    if (cached && at - cached.at < CACHE_MS) return cached.value;
    const value = readSnapshot(ctx.services.get("k8s"));
    cached = { at, value };
    value.catch(() => {
      if (cached?.value === value) cached = undefined;
    });
    return value;
  };

  const read = async () => {
    try {
      return await load();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(
        502,
        `Could not read the Postgres clusters: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  ctx.health.addProvider(createHealthProvider(load, now));

  ctx.route("GET /api/postgres/cluster", async () => clusterView(await read(), now().toISOString()));
  ctx.route("GET /api/postgres/databases", async () => {
    const snapshot = await read();
    return databaseViews(snapshot, await readStats(primaryPod(snapshot), fetcher));
  });
}

const postgres: Module = {
  id: "postgres",
  milestone: "B",
  migrations,
  register: (ctx) => register(ctx),
};

export default postgres;

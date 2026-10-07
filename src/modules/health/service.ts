import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";
import { CATEGORIES } from "../../contracts/health.js";
import type {
  Category,
  CategoryDetail,
  CheckHistory,
  CheckResult,
  HealthBoard,
  HealthProvider,
  ProviderState,
} from "../../contracts/health.js";
import type { ModuleContext } from "../../contracts/module.js";
import { errorMessage } from "../../runtime/log.js";
import { createDemoProvider } from "./demo.js";
import { createLease, type Lease } from "./lease.js";
import { applyRule, buildTile, worst, type ProviderResult } from "./rollup.js";
import { declareSettings, ruleFor, type HealthSettings } from "./settings.js";
import { createStore, type ProviderRun, type Store } from "./store.js";

// Milestone A's categories always get a tile, so an empty install shows
// what it will watch; later ones appear once something reports into them.
const ALWAYS_SHOWN: readonly Category[] = ["cluster", "storage", "backups", "gitops", "hosts", "checks"];

const LEASE_TTL_MS = 30_000;
const LEASE_RENEW_MS = 10_000;
const MAX_COLLECT_MS = 60_000;
const PRUNE_EVERY_MS = 6 * 3_600_000;
const DAY_MS = 86_400_000;

const resultSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  status: z.enum(["ok", "warn", "crit", "unknown", "absent"]),
  value: z.union([z.number(), z.string()]).optional(),
  detail: z.string(),
  raw: z.unknown().optional(),
  deepLink: z.string().optional(),
  object: z.object({ kind: z.string().min(1), namespace: z.string().optional(), name: z.string().min(1) }).optional(),
  observedAt: z.string().optional(),
});
const resultsSchema = z.array(resultSchema);

export interface HealthOptions {
  now?: () => number;
  holder?: string;
}

export interface HealthService {
  lease: Lease;
  settings: HealthSettings;
  store: Store;
  // Scheduled runs are skipped unless this instance holds the lease; a
  // forced run (the API's "run now") is not.
  run(providerId: string, options?: { force?: boolean }): Promise<CheckResult[] | null>;
  board(): HealthBoard;
  category(category: Category): CategoryDetail;
  history(providerId: string, checkId: string, from?: string, to?: string): CheckHistory;
  prune(): number;
}

function collectTimeout(provider: HealthProvider): number {
  return Math.min(provider.intervalMs, MAX_COLLECT_MS);
}

async function collectWithTimeout(provider: HealthProvider): Promise<unknown> {
  const ms = collectTimeout(provider);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`collect() timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([provider.collect(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function startHealth(ctx: ModuleContext, options: HealthOptions = {}): HealthService {
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const holder = options.holder ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const settings = declareSettings(ctx.settings);
  const store = createStore(ctx.db, ctx.orgId);
  const lease = createLease(ctx.db, ctx.orgId, "health.scheduler", holder, LEASE_TTL_MS, now);
  const providers = new Map<string, HealthProvider>();

  // Taken before any provider job can tick, so the first run isn't skipped.
  lease.acquire();
  ctx.scheduler.every("lease", LEASE_RENEW_MS, () => void lease.acquire(), { jitterMs: 1000 });

  async function run(providerId: string, { force = false } = {}): Promise<CheckResult[] | null> {
    const provider = providers.get(providerId);
    if (!provider) return null;
    if (!force && !lease.held()) return null;

    const at = iso();
    let collected: CheckResult[];
    let error: string | undefined;
    try {
      const parsed = resultsSchema.safeParse(await collectWithTimeout(provider));
      if (!parsed.success) throw new Error(`collect() returned malformed results: ${parsed.error.issues[0]?.message}`);
      collected = parsed.data.map((r) => {
        const { observedAt, ...rest } = r;
        return { ...rest, observedAt: observedAt ?? at } as CheckResult;
      });
    } catch (err) {
      error = errorMessage(err);
      const detail = `${provider.label} could not collect: ${error}`;
      const known = store.results(providerId).filter((r) => r.status !== "absent");
      collected =
        known.length > 0
          ? known.map((r) => ({ ...r, status: "unknown", detail, raw: { error }, observedAt: at }))
          : [{ id: "collect", label: provider.label, status: "unknown", detail, raw: { error }, observedAt: at }];
      ctx.log.warn("Health provider failed", { provider: providerId, error });
    }

    const rules = settings.rules.get();
    const judged = collected.map((r) => applyRule(r, ruleFor(rules, providerId, r.id)));
    const changes = store.record(providerId, judged, at, holder, error);
    for (const change of changes) ctx.bus.emit("health.changed", change);
    return collected;
  }

  // A provider that hasn't reported for three intervals (plus slack for a
  // lease handover) is shown as unknown: its last results are no longer
  // evidence of anything.
  function providerState(
    provider: HealthProvider,
    results: CheckResult[],
    last: ProviderRun | undefined
  ): ProviderState {
    const base = { id: provider.id, label: provider.label, category: provider.category };
    if (!last) return { ...base, status: "unknown", results };
    const staleAfter = 3 * provider.intervalMs + LEASE_TTL_MS + 30_000;
    if (now() - Date.parse(last.lastRunAt) > staleAfter) {
      const stale = results.map((r) =>
        r.status === "absent"
          ? r
          : { ...r, status: "unknown" as const, detail: `Stale since ${last.lastRunAt}: ${r.detail}` }
      );
      return {
        ...base,
        status: worst(
          stale.map((r) => r.status),
          "unknown"
        ),
        lastRunAt: last.lastRunAt,
        lastError: last.lastError ?? `No result since ${last.lastRunAt}`,
        results: stale,
      };
    }
    return {
      ...base,
      status: results.length ? worst(results.map((r) => r.status)) : "unknown",
      lastRunAt: last.lastRunAt,
      ...(last.lastError ? { lastError: last.lastError } : {}),
      results,
    };
  }

  function states(): ProviderState[] {
    const results = store.allResults();
    const runs = store.runs();
    return [...providers.values()]
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .map((p) => providerState(p, results.get(p.id) ?? [], runs.get(p.id)));
  }

  function tileResults(list: ProviderState[]): ProviderResult[] {
    return list.flatMap((state) =>
      state.results.length === 0 && state.status === "unknown"
        ? [
            {
              providerId: state.id,
              id: "collect",
              label: state.label,
              status: "unknown" as const,
              detail: state.lastError ?? "Waiting for the first run",
              observedAt: state.lastRunAt ?? iso(),
            },
          ]
        : state.results.map((r) => ({ ...r, providerId: state.id }))
    );
  }

  const service: HealthService = {
    lease,
    settings,
    store,
    run,

    board() {
      const all = states();
      const shown = CATEGORIES.filter((c) => ALWAYS_SHOWN.includes(c) || all.some((s) => s.category === c));
      const tiles = shown.map((category) => {
        const members = all.filter((s) => s.category === category);
        return buildTile(category, tileResults(members), members.length);
      });
      return { status: worst(tiles.map((t) => t.status)), tiles, generatedAt: iso() };
    },

    category(category) {
      const members = states().filter((s) => s.category === category);
      return {
        category,
        status: members.length ? worst(tileResults(members).map((r) => r.status)) : "absent",
        providers: members,
        links: settings.links.get()[category] ?? [],
      };
    },

    history(providerId, checkId, from, to) {
      const end = to ?? iso();
      const start = from ?? new Date(Date.parse(end) - DAY_MS).toISOString();
      return { providerId, checkId, points: store.history(providerId, checkId, start, end) };
    },

    prune() {
      return store.prune(new Date(now() - settings.historyDays.get() * DAY_MS).toISOString());
    },
  };

  ctx.health.subscribe((provider) => {
    if (providers.has(provider.id)) {
      ctx.log.error("Duplicate health provider id; keeping the first", { provider: provider.id });
      return;
    }
    providers.set(provider.id, provider);
    ctx.scheduler.every(`provider:${provider.id}`, provider.intervalMs, () => run(provider.id), {
      // Above collect()'s own timeout, so a slow provider is recorded as
      // unknown by run() rather than abandoned by the scheduler.
      timeoutMs: collectTimeout(provider) + 5_000,
    });
  });

  ctx.scheduler.every(
    "prune-history",
    PRUNE_EVERY_MS,
    () => {
      if (lease.held()) service.prune();
    },
    { runImmediately: false }
  );

  if (settings.demo.get()) ctx.health.addProvider(createDemoProvider());

  return service;
}

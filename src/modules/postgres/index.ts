import type { Request } from "express";
import { z } from "zod";
import type { DeployActionRequest } from "../../contracts/deploy.js";
import type { Module, ModuleContext } from "../../contracts/module.js";
import { HttpError } from "../../runtime/http.js";
import { backupView, clusterPvcs, createBackupSource, readBackupObjects } from "./backups.js";
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

  const targets = () => (ctx.services.has("storage-targets") ? ctx.services.get("storage-targets") : undefined);
  const backups = async () => {
    const snapshot = await read();
    const k8s = ctx.services.get("k8s");
    const state = await backupView(snapshot, await readBackupObjects(k8s), targets(), now());
    return { snapshot, state, k8s };
  };

  ctx.backups.addSource(
    createBackupSource(async () => {
      const { snapshot, state, k8s } = await backups();
      const pvcs = snapshot.current ? await clusterPvcs(k8s, snapshot.current.metadata.name) : [];
      return { snapshot, state, pvcs };
    })
  );

  // Every change is a deploy action started as the caller, so its
  // permission, audit and job log are the deploy module's.
  const run = async (req: Request, body: DeployActionRequest) => {
    const job = await ctx.call(req, "POST /api/deploy/actions/run", { body });
    cached = undefined;
    return job;
  };

  ctx.route("GET /api/postgres/cluster", async () => clusterView(await read(), now().toISOString()));
  ctx.route("GET /api/postgres/databases", async () => {
    const snapshot = await read();
    return databaseViews(snapshot, await readStats(primaryPod(snapshot), fetcher));
  });

  ctx.route("GET /api/postgres/backups", async () => (await backups()).state.view);

  ctx.route("PUT /api/postgres/backups", async (req, res) => {
    if (!ctx.require(req, res, "write")) return undefined;
    const body = parse(backupBody, req.body);
    if (body.connectorId !== null) {
      const service = targets();
      if (!service) throw new HttpError(503, "Storage targets are not available.");
      if (!(await service.get(body.connectorId))) throw new HttpError(404, `No storage target "${body.connectorId}".`);
    }
    return run(req, { kind: "pg-backups", ...body } as DeployActionRequest);
  });

  ctx.route("POST /api/postgres/backups/now", async (req, res) => {
    if (!ctx.require(req, res, "write")) return undefined;
    return run(req, { kind: "pg-backup-now" });
  });

  ctx.route("POST /api/postgres/restore/plan", async (req, res) => {
    if (!ctx.require(req, res, "write")) return undefined;
    return ctx.call(req, "POST /api/deploy/actions/plan", { body: restoreRequest(req.body) });
  });

  ctx.route("POST /api/postgres/restore", async (req, res) => {
    if (!ctx.require(req, res, "write")) return undefined;
    return run(req, restoreRequest(req.body));
  });
}

const backupBody = z.object({
  connectorId: z.string().trim().min(1).max(100).nullable(),
  schedule: z
    .string()
    .trim()
    .regex(/^[0-9*,/-]+( [0-9*,/-]+){4}$/, "must be a five-field cron such as 0 2 * * *")
    .optional(),
  retention: z.number().int().min(1).max(365).optional(),
});

const restoreBody = z
  .object({
    at: z.string().datetime({ offset: true }).optional(),
    dumpId: z.string().trim().min(1).max(63).optional(),
  })
  .refine((b) => (b.at === undefined) !== (b.dumpId === undefined), "give exactly one of at or dumpId");

const restoreRequest = (body: unknown): DeployActionRequest => ({ kind: "pg-restore", ...parse(restoreBody, body) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

const postgres: Module = {
  id: "postgres",
  milestone: "B",
  migrations,
  register: (ctx) => register(ctx),
};

export default postgres;

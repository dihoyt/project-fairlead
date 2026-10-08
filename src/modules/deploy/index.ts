import { z } from "zod";
import type { DeployJobRequest, DeployRequest } from "../../contracts/deploy.js";
import type { Module, ModuleContext } from "../../contracts/module.js";
import { HttpError } from "../../runtime/http.js";
import { declareConfig } from "./config.js";
import { migrations } from "./migrations.js";
import { Deployer, LOG_LINES, MAX_TAIL, type DeployerOptions } from "./runner.js";
import { Store } from "./store.js";

const RECONCILE_MS = 15_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const requestSchema = z.object({
  appId: z.string().min(1).max(100),
  namespace: z.string().max(63).optional(),
  inputs: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}),
});
const jobRequestSchema = requestSchema.extend({ mode: z.enum(["install", "dry-run"]) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HttpError(400, `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  return result.data;
}

function positive(value: string | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `${name} must be a positive whole number.`);
  return Math.min(n, max);
}

export function registerDeploy(ctx: ModuleContext, options: DeployerOptions = {}): Deployer {
  const config = declareConfig(ctx.settings);
  const deployer = new Deployer(ctx, new Store(ctx.db, ctx.orgId), config, options);

  ctx.scheduler.every("deploy.reconcile", RECONCILE_MS, () => deployer.reconcile());

  ctx.route("GET /api/deploy/status", () => deployer.status());

  ctx.route("POST /api/deploy/plan", async (req, res) => {
    if (!ctx.require(req, res, "write")) return undefined;
    return deployer.plan(parse(requestSchema, req.body) as DeployRequest);
  });

  ctx.route("POST /api/deploy/jobs", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    return deployer.start(user, parse(jobRequestSchema, req.body) as DeployJobRequest);
  });

  ctx.route("GET /api/deploy/jobs", (req) =>
    deployer.list(req.query.appId || undefined, positive(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT, "limit"))
  );

  ctx.route("GET /api/deploy/jobs/:id", (req) => deployer.mustGet(req.params.id).view);

  ctx.route("GET /api/deploy/jobs/:id/logs", (req) =>
    deployer.logs(req.params.id, positive(req.query.tail, LOG_LINES, MAX_TAIL, "tail"))
  );

  ctx.route("GET /api/deploy/jobs/:id/logs/stream", async (req, res) => {
    await deployer.follow(req.params.id, res);
    return undefined;
  });

  ctx.route("POST /api/deploy/jobs/:id/cancel", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    return deployer.cancel(user, req.params.id);
  });
  return deployer;
}

const mod: Module = {
  id: "deploy",
  milestone: "A",
  migrations,
  register(ctx) {
    registerDeploy(ctx);
  },
};

export default mod;

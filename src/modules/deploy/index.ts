import { z } from "zod";
import type {
  AccessMode,
  BundleRequest,
  DeployJobRequest,
  DeployRequest,
  UpgradeRequest,
} from "../../contracts/deploy.js";
import type { RouteKey } from "../../contracts/api.js";
import type { CallInput, Module, ModuleContext } from "../../contracts/module.js";
import { HttpError } from "../../runtime/http.js";
import { ACCESS_MODES } from "./access.js";
import { registerBackupRoutes } from "./actions/backup.js";
import { actionSchema } from "./actions/index.js";
import { Bundles } from "./bundles.js";
import { declareConfig } from "./config.js";
import { registerGate } from "./gateHealth.js";
import { migrations } from "./migrations.js";
import { declarePorts, portsView } from "./ports.js";
import { Deployer, LOG_LINES, MAX_TAIL, type DeployerOptions } from "./runner.js";
import { Store } from "./store.js";

const RECONCILE_MS = 15_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const requestSchema = z.object({
  appId: z.string().min(1).max(100),
  namespace: z.string().max(63).optional(),
  inputs: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}),
  public: z.boolean().optional(),
});
const jobRequestSchema = requestSchema.extend({ mode: z.enum(["install", "dry-run"]) });
const values = z.record(z.string(), z.union([z.string(), z.boolean()]));
const accessSchema = z.object({
  mode: z.enum(ACCESS_MODES as [AccessMode, ...AccessMode[]]),
  baseDomain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^(?=.{1,253}$)[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?(\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)+$/, {
      message: "must be a domain like example.com",
    }),
});
const bundleSchema = z.object({
  bundleId: z.string().min(1).max(100),
  inputs: values.default({}),
  apps: z.record(z.string(), values).optional(),
  include: z.array(z.string().max(100)).max(100).optional(),
  public: z.array(z.string().max(100)).max(100).optional(),
});

const upgradeSchema = z.object({ appIds: z.array(z.string().min(1).max(100)).min(1).max(100).optional() });

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

export function registerDeploy(
  ctx: ModuleContext,
  options: DeployerOptions = {}
): { deployer: Deployer; bundles: Bundles } {
  const config = declareConfig(ctx.settings);
  const forwardedPorts = declarePorts(ctx.settings);
  const deployer = new Deployer(ctx, new Store(ctx.db, ctx.orgId), config, options);
  const bundles = new Bundles(ctx, deployer, options.now);
  ctx.services.provide("deploy", {
    releases: async () => deployer.releases(),
    access: () => deployer.accessView(),
    gate: () => deployer.gateStatus(),
    planEntry: (entry, request) => deployer.plan(request, entry),
    startEntry: (actor, entry, request) => deployer.start(actor, request, {}, entry),
  });

  ctx.scheduler.every("deploy.reconcile", RECONCILE_MS, async () => {
    await deployer.reconcile();
    await bundles.advanceAll();
  });
  ctx.bus.on("deploy.finished", () => bundles.advanceAll());

  ctx.route("GET /api/deploy/status", () => deployer.status());

  ctx.route("GET /api/deploy/access", () => deployer.accessView());

  ctx.route("GET /api/deploy/gate", () => deployer.gateStatus());
  registerGate(ctx, deployer);

  ctx.route("PUT /api/deploy/access", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    deployer.saveAccess(user.id, parse(accessSchema, req.body));
    return deployer.accessView(true);
  });

  ctx.route("POST /api/deploy/plan", async (req, res) => {
    if (!ctx.require(req, res, "write")) return undefined;
    return deployer.plan(parse(requestSchema, req.body) as DeployRequest);
  });

  ctx.route("POST /api/deploy/jobs", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    return deployer.start(user.id, parse(jobRequestSchema, req.body) as DeployJobRequest);
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
    return deployer.cancel(user.id, req.params.id);
  });

  ctx.route("POST /api/deploy/bundles/plan", async (req, res) => {
    if (!ctx.require(req, res, "write")) return undefined;
    return bundles.plan(parse(bundleSchema, req.body) as BundleRequest);
  });

  ctx.route("POST /api/deploy/bundles", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    return bundles.start(user.id, parse(bundleSchema, req.body) as BundleRequest);
  });

  ctx.route("GET /api/deploy/bundles", () => bundles.list());

  ctx.route("GET /api/deploy/bundles/:id", (req) => bundles.get(req.params.id));

  ctx.route("POST /api/deploy/bundles/:id/cancel", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    return bundles.cancel(user.id, req.params.id);
  });
  ctx.route("GET /api/deploy/ports", () =>
    portsView({
      setting: forwardedPorts,
      k8s: ctx.services.has("k8s") ? ctx.services.get("k8s") : undefined,
      releases: deployer.releases(),
      wanted: ctx.services.has("templates") ? ctx.services.get("templates").forwardedPorts() : [],
    })
  );

  ctx.route("GET /api/deploy/upgrades", (req) => deployer.upgradeReport(req.query.refresh === "1"));

  ctx.route("POST /api/deploy/upgrades", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    return bundles.startUpgrade(user.id, parse(upgradeSchema, req.body) as UpgradeRequest);
  });

  // The caller's own identity for the routes an action reads (the Longhorn
  // advice), so they see what that user would.
  const caller =
    (req: Parameters<ModuleContext["call"]>[0]) =>
    <K extends RouteKey>(key: K, input?: CallInput<K>) =>
      ctx.call(req, key, input);

  ctx.route("POST /api/deploy/actions/plan", async (req, res) => {
    if (!ctx.require(req, res, "write")) return undefined;
    return (await deployer.renderAction(parse(actionSchema, req.body), caller(req))).plan;
  });

  ctx.route("POST /api/deploy/actions/run", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    return deployer.startAction(user.id, parse(actionSchema, req.body), caller(req));
  });

  registerBackupRoutes(ctx, {
    jobs: { get: (id) => deployer.get(id) },
    now: options.now,
    fetch: options.fetch,
  });
  return { deployer, bundles };
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

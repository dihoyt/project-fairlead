import type { Express, Request, Router } from "express";
import type { Database } from "better-sqlite3";
import type { BackupsRegistry } from "../contracts/backups.js";
import type { EventBus, Events } from "../contracts/events.js";
import type { HealthRegistry } from "../contracts/health.js";
import type { MetricsRegistry } from "../contracts/metrics.js";
import type { Module } from "../contracts/module.js";
import type { CreatePlatform, Platform, User } from "../contracts/platform.js";
import type { Logger, ResetRegistry, ServiceRegistry } from "../contracts/runtime.js";
import type { ModuleStatus } from "../contracts/system.js";
import { createEventBus } from "./bus.js";
import { buildContext, type SharedRuntime } from "./context.js";
import { createLogger, errorMessage } from "./log.js";
import { applyMigrations, DEFAULT_ORG_ID, runtimeMigrations, schemaVersion } from "./migrations.js";
import {
  createBackupsRegistry,
  createHealthRegistry,
  createMetricsRegistry,
  createResetRegistry,
} from "./registries.js";
import { createScheduler, type SchedulerCore } from "./scheduler.js";
import { createServiceRegistry } from "./services.js";

export interface RuntimeOptions {
  db: Database;
  dataDir: string;
  modules: readonly Module[];
  createPlatform: CreatePlatform;
  // Tests only; see PlatformDeps.identify.
  identify?: (req: Request) => User | null;
  logFor?: (scope: string) => Logger;
}

export interface Runtime {
  db: Database;
  platform: Platform;
  bus: EventBus<Events>;
  scheduler: SchedulerCore;
  health: HealthRegistry;
  metrics: MetricsRegistry;
  backups: BackupsRegistry;
  reset: ResetRegistry;
  services: ServiceRegistry;
  orgId: string;
  log: Logger;
  moduleStatus(): ModuleStatus[];
  mountModules(app: Express): void;
  stop(): Promise<void>;
}

// Order of events at start: runtime tables, the platform's tables, then per
// module (in the order given) its migrations and its register(). A
// migration failure stops start-up, so a broken rollout leaves the old pod
// serving; a register() failure only marks that module as failed.
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const logFor = options.logFor ?? ((scope: string) => createLogger(scope));
  const log = logFor("runtime");
  const { db } = options;

  applyMigrations(db, "runtime", runtimeMigrations);
  const platform = options.createPlatform({
    db,
    dataDir: options.dataDir,
    orgId: DEFAULT_ORG_ID,
    ...(options.identify ? { identify: options.identify } : {}),
  });
  applyMigrations(db, "platform", platform.migrations);

  const shared: SharedRuntime = {
    db,
    platform,
    bus: createEventBus<Events>(logFor("bus")),
    scheduler: createScheduler(logFor("scheduler")),
    health: createHealthRegistry(logFor("health-registry")),
    metrics: createMetricsRegistry(logFor("metrics-registry")),
    backups: createBackupsRegistry(logFor("backups-registry")),
    reset: createResetRegistry(),
    services: createServiceRegistry(),
    orgId: DEFAULT_ORG_ID,
    logFor,
  };

  const seen = new Set<string>();
  const statuses = new Map<string, ModuleStatus>();
  const routers: Array<{ id: string; router: Router; publicRouter: Router }> = [];

  for (const mod of options.modules) {
    if (seen.has(mod.id)) throw new Error(`Module "${mod.id}" is listed twice.`);
    seen.add(mod.id);
    applyMigrations(db, mod.id, mod.migrations ?? []);
    const status: ModuleStatus = {
      id: mod.id,
      milestone: mod.milestone,
      registered: false,
      schemaVersion: schemaVersion(db, mod.id),
    };
    statuses.set(mod.id, status);
    const ctx = buildContext(mod.id, shared);
    try {
      await mod.register(ctx);
      status.registered = true;
      routers.push({ id: mod.id, router: ctx.router, publicRouter: ctx.publicRouter });
    } catch (err) {
      status.error = errorMessage(err);
      log.error("Module failed to register", { module: mod.id, error: status.error });
    }
  }

  log.info("Runtime ready", {
    modules: [...statuses.values()].filter((s) => s.registered).length,
    failed: [...statuses.values()].filter((s) => s.error).map((s) => s.id),
  });

  return {
    db,
    platform,
    bus: shared.bus,
    scheduler: shared.scheduler,
    health: shared.health,
    metrics: shared.metrics,
    backups: shared.backups,
    reset: shared.reset,
    services: shared.services,
    orgId: DEFAULT_ORG_ID,
    log,
    moduleStatus: () => [...statuses.values()].map((s) => ({ ...s })),
    mountModules(app) {
      for (const { id, router } of routers) app.use(`/api/${id}`, router);
      for (const { publicRouter } of routers) app.use(publicRouter);
    },
    async stop() {
      await shared.scheduler.stopAll();
    },
  };
}

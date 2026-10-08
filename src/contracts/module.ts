import type { Request, Response, Router } from "express";
import type { Database } from "better-sqlite3";
import type { HealthRegistry } from "./health.js";
import type { MetricsRegistry } from "./metrics.js";
import type { BackupsRegistry } from "./backups.js";
import type { EventBus, Events } from "./events.js";
import type { Action, AuditLog, SecretStore, SettingsRegistry, User } from "./platform.js";
import type { Logger, Migration, Scheduler, ServiceRegistry } from "./runtime.js";
import type { ApiRoutes } from "./api.js";
import type { RouteHandler } from "./routing.js";

// Every planned module, Milestone A then B. Order here is not load order;
// src/modules/index.ts owns that.
export const MODULE_IDS = [
  "k8s",
  "health",
  "metrics",
  "notify",
  "cluster",
  "longhorn",
  "velero",
  "fleet",
  "hosts",
  "checks",
  "backups",
  "metrics-k8s",
  "workloads",
  "onboarding",
  "catalog",
  "deploy",
  "connectors",
  "connector-cloudflare",
  "connector-entra",
  "templates",
  "publish",
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

export interface ModuleContext {
  moduleId: ModuleId;
  // Mounted at /api/<moduleId>, after the platform's authentication: every
  // request reaching it has an identity.
  router: Router;
  // Binds a contract route (src/contracts/api.ts) on this module's router
  // with typed params, query, body and response. Refuses a route outside
  // /api/<moduleId>/.
  route<K extends keyof ApiRoutes>(key: K, handler: RouteHandler<K>): void;
  // Shared database; this module's migrations are applied before register().
  db: Database;
  settings: SettingsRegistry;
  secrets: SecretStore;
  audit: AuditLog;
  bus: EventBus<Events>;
  scheduler: Scheduler;
  // The caller's identity. Throws on a request with none, which cannot reach
  // a module router.
  identify(req: Request): User;
  can(user: User, action: Action): boolean;
  // Responds 403 and returns null when the caller may not do `action`.
  require(req: Request, res: Response, action: Action): User | null;
  health: HealthRegistry;
  metrics: MetricsRegistry;
  backups: BackupsRegistry;
  services: ServiceRegistry;
  // Always the default org under tenancy A; written into every org_id column.
  orgId: string;
  log: Logger;
}

export interface Module {
  id: ModuleId;
  milestone: "A" | "B";
  migrations?: readonly Migration[];
  register(ctx: ModuleContext): void | Promise<void>;
}

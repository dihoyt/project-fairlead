import type { Request, Response, Router } from "express";
import type { Database } from "better-sqlite3";
import type { HealthRegistry } from "./health.js";
import type { MetricsRegistry } from "./metrics.js";
import type { BackupsRegistry } from "./backups.js";
import type { EventBus, Events } from "./events.js";
import type { Action, AuditLog, SecretStore, SettingsRegistry, User } from "./platform.js";
import type { Logger, Migration, ResetRegistry, Scheduler, ServiceRegistry } from "./runtime.js";
import type { ApiRoutes, PublicRouteKey, RouteKey } from "./api.js";
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
  "mcp",
  "connectors",
  "connector-cloudflare",
  "connector-entra",
  "connector-storage",
  "postgres",
  "templates",
  "publish",
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

export interface CallInput<K extends RouteKey> {
  params?: ApiRoutes[K]["params"];
  query?: ApiRoutes[K]["query"];
  body?: ApiRoutes[K]["body"];
}

export interface ModuleContext {
  moduleId: ModuleId;
  // Mounted at /api/<moduleId>, after the platform's authentication: every
  // request reaching it has an identity.
  router: Router;
  // Binds a contract route (src/contracts/api.ts) on this module's router
  // with typed params, query, body and response. Refuses a route outside
  // /api/<moduleId>/.
  route<K extends keyof ApiRoutes>(key: K, handler: RouteHandler<K>): void;
  // Mounted at the app root, before the client's static files. Holds only
  // what publicRoute binds.
  publicRouter: Router;
  // Binds a route from PUBLIC_ROUTES (src/contracts/api.ts) that this module
  // owns: no identity, mounted at the app root after the platform. identify()
  // and require() are not for these requests; the handler decides who may
  // have the response. Thrown errors answer as plain text.
  publicRoute<K extends PublicRouteKey>(key: K, handler: RouteHandler<K>): void;
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
  // The namespaces the caller may see: null for every one (any session, or a
  // token whose grant names none). A route that lists objects across
  // namespaces keeps only these; one that acts on a single namespace is
  // already refused outside them before its handler runs (./grants.ts).
  visibleNamespaces(req: Request): readonly string[] | null;
  // Calls a JSON route from ./api.ts in-process, as the caller of `req`
  // (Platform.vouch), through the same authentication, permission checks,
  // validation and audit as any other request: what another module offers
  // over HTTP without importing it. Resolves to the parsed 2xx body; rejects
  // with an HttpError carrying the status and the route's error message.
  // Not for streams or text bodies.
  call<K extends RouteKey>(req: Request, key: K, input?: CallInput<K>): Promise<ApiRoutes[K]["response"]>;
  health: HealthRegistry;
  metrics: MetricsRegistry;
  backups: BackupsRegistry;
  // Registers what this module clears for each reset scope it owns.
  reset: ResetRegistry;
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

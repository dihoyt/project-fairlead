import express from "express";
import type { Request } from "express";
import { createEventBus } from "../../runtime/bus.js";
import { buildContext } from "../../runtime/context.js";
import { openDatabase } from "../../runtime/db.js";
import { apiErrorHandler } from "../../runtime/http.js";
import { silentLogger } from "../../runtime/log.js";
import { applyMigrations, DEFAULT_ORG_ID, runtimeMigrations } from "../../runtime/migrations.js";
import { createBackupsRegistry, createHealthRegistry, createMetricsRegistry } from "../../runtime/registries.js";
import { createScheduler } from "../../runtime/scheduler.js";
import { createServiceRegistry } from "../../runtime/services.js";
import type { ApiRoutes, RouteKey } from "../api.js";
import type { Events } from "../events.js";
import type { CallInput, ModuleContext, ModuleId } from "../module.js";
import type { AuditEntry, Platform, User } from "../platform.js";
import type { Migration, Services } from "../runtime.js";
import type { Sample } from "../metrics.js";
import { apiMocks } from "./api.js";

export const mockAdmin: User = {
  id: "admin",
  name: "Admin",
  email: "admin@example.test",
  groups: [],
  admin: true,
  source: "password",
  mustChangePassword: false,
  orgId: DEFAULT_ORG_ID,
};

export const mockViewer: User = { ...mockAdmin, id: "viewer", name: "Viewer", admin: false };

const secretKey = (scope: string, id: string) => `${scope}/${id}`;

export interface MockContextOptions {
  migrations?: readonly Migration[];
  // Who identify() returns for every request. Default: mockAdmin.
  user?: User | null;
  // Values for settings by key; anything else gets its default.
  settings?: Record<string, unknown>;
  services?: Partial<Services>;
  // Install a sink that collects written samples into MockContext.samples.
  // Default: true, except for module "metrics", which installs its own.
  metricsSink?: boolean;
  // Answers for ctx.call by route; a route not listed answers its apiMocks
  // response. Throw an HttpError (src/runtime/http.ts) for an error status.
  calls?: MockCalls;
}

export type MockCalls = {
  [K in RouteKey]?: (input: CallInput<K>, user: User) => ApiRoutes[K]["response"] | Promise<ApiRoutes[K]["response"]>;
};

export interface RecordedCall {
  key: RouteKey;
  input: CallInput<RouteKey>;
  user: User;
}

export interface MockContext {
  ctx: ModuleContext;
  // An express app with ctx.router mounted at /api/<moduleId> and
  // ctx.publicRouter at the root, for HTTP tests.
  app: express.Express;
  audit: AuditEntry[];
  // Every sample written through ctx.metrics.write, when the mock's sink is installed.
  samples: Sample[];
  secrets: Map<string, string>;
  // Every ctx.call, in order, with the identity it was made as.
  calls: RecordedCall[];
  setUser(user: User | null): void;
  close(): Promise<void>;
}

// A real ModuleContext over an in-memory database, the real bus, scheduler
// and registries, and a platform whose settings, secrets and audit are
// inspectable. The module's migrations are applied, as at start-up.
export function createMockContext(moduleId: ModuleId, options: MockContextOptions = {}): MockContext {
  const db = openDatabase(":memory:");
  applyMigrations(db, "runtime", runtimeMigrations);
  applyMigrations(db, moduleId, options.migrations ?? []);

  let user: User | null = options.user === undefined ? mockAdmin : options.user;
  const audit: AuditEntry[] = [];
  const secrets = new Map<string, string>();
  const samples: Sample[] = [];
  const settingValues = options.settings ?? {};

  const platform: Platform = {
    migrations: [],
    early() {},
    install() {},
    identify: (_req: Request) => user,
    can: (who, action) => action === "read" || (who.admin && who.token?.scope !== "read"),
    vouch: () => "mock-ticket",
    settings: {
      declare(spec) {
        const value = () => (spec.key in settingValues ? spec.schema.parse(settingValues[spec.key]) : spec.default);
        return { key: spec.key, get: value, source: () => (spec.key in settingValues ? "ui" : "default") };
      },
    },
    secrets: {
      get: async (scope, id) => secrets.get(secretKey(scope, id)) ?? null,
      has: async (scope, id) => secrets.has(secretKey(scope, id)),
      put: async (scope, id, value) => {
        secrets.set(secretKey(scope, id), value);
      },
      delete: async (scope, id) => {
        secrets.delete(secretKey(scope, id));
      },
    },
    audit: { record: (entry) => void audit.push(entry) },
    draining: () => false,
    handleSignals() {},
  };

  const scheduler = createScheduler(silentLogger);
  const metrics = createMetricsRegistry(silentLogger);
  if (options.metricsSink ?? moduleId !== "metrics") metrics.setSink((batch) => void samples.push(...batch));
  const services = createServiceRegistry();
  for (const [name, impl] of Object.entries(options.services ?? {})) {
    services.provide(name as keyof Services, impl as Services[keyof Services]);
  }

  const ctx = buildContext(moduleId, {
    db,
    platform,
    bus: createEventBus<Events>(silentLogger),
    scheduler,
    health: createHealthRegistry(silentLogger),
    metrics,
    backups: createBackupsRegistry(silentLogger),
    services,
    orgId: DEFAULT_ORG_ID,
    logFor: () => silentLogger,
  });

  const calls: RecordedCall[] = [];
  const answers = options.calls ?? {};
  ctx.call = async (req, key, input = {}) => {
    const caller = ctx.identify(req);
    calls.push({ key, input: input as CallInput<RouteKey>, user: caller });
    const answer = answers[key] as ((input: unknown, user: User) => unknown) | undefined;
    if (answer) return (await answer(input, caller)) as never;
    return structuredClone(apiMocks[key]) as never;
  };

  const app = express();
  app.use(express.json());
  app.use(`/api/${moduleId}`, ctx.router);
  app.use(ctx.publicRouter);
  app.use(apiErrorHandler(silentLogger));

  return {
    ctx,
    app,
    audit,
    samples,
    secrets,
    calls,
    setUser(next) {
      user = next;
    },
    async close() {
      await scheduler.stopAll();
      db.close();
    },
  };
}

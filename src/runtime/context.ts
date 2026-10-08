import express from "express";
import type { Database } from "better-sqlite3";
import type { BackupsRegistry } from "../contracts/backups.js";
import type { EventBus, Events } from "../contracts/events.js";
import type { HealthRegistry } from "../contracts/health.js";
import type { MetricsRegistry } from "../contracts/metrics.js";
import type { ModuleContext, ModuleId } from "../contracts/module.js";
import type { Platform, SecretStore, SettingsRegistry } from "../contracts/platform.js";
import type { Logger, ServiceRegistry } from "../contracts/runtime.js";
import type { SchedulerCore } from "./scheduler.js";
import { bindPublicRoute, bindRoute, publicErrorHandler } from "./http.js";

export interface SharedRuntime {
  db: Database;
  platform: Platform;
  bus: EventBus<Events>;
  scheduler: SchedulerCore;
  health: HealthRegistry;
  metrics: MetricsRegistry;
  backups: BackupsRegistry;
  services: ServiceRegistry;
  orgId: string;
  logFor(scope: string): Logger;
}

function scopedSettings(moduleId: string, settings: SettingsRegistry): SettingsRegistry {
  return {
    declare(spec) {
      if (!spec.key.startsWith(`${moduleId}.`)) {
        throw new Error(`Module "${moduleId}" cannot declare setting "${spec.key}": keys start with "${moduleId}.".`);
      }
      return settings.declare(spec);
    },
  };
}

function scopedSecrets(moduleId: string, secrets: SecretStore): SecretStore {
  const check = (scope: string) => {
    if (scope !== moduleId && !scope.startsWith(`${moduleId}:`)) {
      throw new Error(`Module "${moduleId}" cannot use secret scope "${scope}".`);
    }
  };
  return {
    get: async (scope, id) => (check(scope), secrets.get(scope, id)),
    has: async (scope, id) => (check(scope), secrets.has(scope, id)),
    put: async (scope, id, value) => (check(scope), secrets.put(scope, id, value)),
    delete: async (scope, id) => (check(scope), secrets.delete(scope, id)),
  };
}

export function buildContext(moduleId: ModuleId, shared: SharedRuntime): ModuleContext {
  const router = express.Router();
  const publicRouter = express.Router();
  const log = shared.logFor(moduleId);
  const { platform } = shared;
  const identify: ModuleContext["identify"] = (req) => {
    const user = platform.identify(req);
    if (!user) throw new Error("identify() called on a request with no identity.");
    return user;
  };
  return {
    moduleId,
    router,
    route: (key, handler) => bindRoute(router, moduleId, key, handler),
    publicRouter,
    publicRoute: (key, handler) => bindPublicRoute(publicRouter, moduleId, key, handler, publicErrorHandler(log)),
    db: shared.db,
    settings: scopedSettings(moduleId, platform.settings),
    secrets: scopedSecrets(moduleId, platform.secrets),
    audit: platform.audit,
    bus: shared.bus,
    scheduler: shared.scheduler.forModule(moduleId),
    identify,
    can: (user, action) => platform.can(user, action),
    require(req, res, action) {
      const user = identify(req);
      if (platform.can(user, action)) return user;
      res.status(403).json({ error: "You don't have permission to do that." });
      return null;
    },
    health: shared.health,
    metrics: shared.metrics,
    backups: shared.backups,
    services: shared.services,
    orgId: shared.orgId,
    log,
  };
}

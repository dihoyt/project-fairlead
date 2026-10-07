import type { Request } from "express";
import type { CreatePlatform, Platform, User } from "../contracts/platform.js";
import { createLogger, errorMessage } from "../runtime/log.js";
import { createAudit } from "./audit.js";
import {
  announceAuthMode,
  authOf,
  createResolver,
  refuseUnready,
  setAuth,
  type AuthResult,
  type PlatformUser,
} from "./auth/identity.js";
import { createLoginLimits } from "./auth/limiter.js";
import { bootstrapAdmin } from "./bootstrap.js";
import type { Core } from "./core.js";
import { platformMigrations } from "./migrations.js";
import { originGuard } from "./originGuard.js";
import { adminRouter } from "./routes/admin.js";
import { authApiRouter, meRoute, oidcRouter } from "./routes/auth.js";
import { totpRouter } from "./routes/totp.js";
import { createSecrets } from "./secrets.js";
import { createSettings } from "./settings.js";
import { createDrain, drainDeadlineMs } from "./shutdown.js";

// Modules see the contract's User and nothing of the account behind it.
function contractUser(user: PlatformUser): User {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    groups: user.groups,
    admin: user.admin,
    source: user.source,
    mustChangePassword: user.mustChangePassword,
    ...(user.mustEnrollTotp !== undefined ? { mustEnrollTotp: user.mustEnrollTotp } : {}),
    orgId: user.orgId,
  };
}

export const createPlatform: CreatePlatform = (deps) => {
  const log = createLogger("platform");
  const core: Core = {
    db: deps.db,
    orgId: deps.orgId,
    settings: createSettings(deps.db, deps.orgId),
    secrets: createSecrets(deps.db, deps.orgId),
    audit: createAudit(deps.db, deps.orgId, log),
    log,
    limits: createLoginLimits(),
  };
  const resolveSession = createResolver(core);
  const resolve = (req: Request, res: Parameters<typeof resolveSession>[1]): AuthResult => {
    if (!deps.identify) return resolveSession(req, res);
    const user = deps.identify(req);
    return { user };
  };
  const drain = createDrain(log);

  if (!deps.identify) announceAuthMode();

  const platform: Platform = {
    migrations: platformMigrations,
    early(app) {
      app.use(drain.guard);
    },
    install(app) {
      // Here rather than at creation: the platform's tables exist from this
      // point, and nothing is served before it.
      if (!deps.identify) bootstrapAdmin(core);

      app.use((req, res, next) => {
        try {
          setAuth(req, resolve(req, res));
          next();
        } catch (err) {
          next(err);
        }
      });
      app.use(originGuard);
      app.use(oidcRouter(core));
      app.get("/api/me", meRoute());
      app.use("/api/auth/totp", totpRouter(core));
      app.use("/api/auth", authApiRouter(core));
      app.use("/api/admin", adminRouter(core));
      // Everything after this (the system routes and every module router)
      // has an identity that is ready to act.
      app.use("/api", (req, res, next) => {
        if (refuseUnready(authOf(req), res) !== null) next();
      });
    },
    identify(req) {
      const user = (authOf(req) ?? resolve(req, null)).user;
      return user === null ? null : contractUser(user);
    },
    // Tenancy A: reading is for anyone signed in; changing anything, and
    // administering the install, is for admins.
    can: (user, action) => user.admin || action === "read",
    settings: core.settings,
    secrets: core.secrets,
    audit: core.audit,
    draining: drain.draining,
    handleSignals(server, stop) {
      let stopping = false;
      const shutdown = async (signal: NodeJS.Signals) => {
        if (stopping) {
          // A second Ctrl+C means now.
          if (signal === "SIGINT") process.exit(1);
          return;
        }
        stopping = true;
        log.info("Shutting down", { signal });
        let code = 0;
        try {
          await drain.drain(server, drainDeadlineMs());
          await stop();
        } catch (err) {
          log.error("Shutdown failed", { error: errorMessage(err) });
          code = 1;
        }
        process.exit(code);
      };
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
      process.on("SIGINT", () => void shutdown("SIGINT"));
    },
  };
  return platform;
};

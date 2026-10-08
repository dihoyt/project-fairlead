import express, { type Express } from "express";
import { MCP_PATH } from "./contracts/mcp.js";
import type { ModuleStatus } from "./contracts/system.js";
import { apiErrorHandler } from "./runtime/http.js";
import type { Runtime } from "./runtime/index.js";
import { parseResetRequest, runReset } from "./runtime/reset.js";

export interface AppOptions {
  // The client's built output; absent in tests.
  publicDir?: string;
  version?: string;
}

export function createApp(runtime: Runtime, options: AppOptions = {}): Express {
  const app = express();
  const { platform } = runtime;
  app.disable("x-powered-by");

  platform.early(app);

  // MCP clients are given the short path; it is served by the mcp module's
  // /api/mcp so it passes through the same authentication as the rest of /api.
  app.use((req, _res, next) => {
    if (req.path === MCP_PATH) req.url = `/api/mcp${req.url.slice(MCP_PATH.length)}`;
    next();
  });

  // Unauthenticated: k8s probes hit these and they disclose nothing.
  // /healthz is readiness and fails during a drain so the Service stops
  // sending new work; /livez is liveness and never fails, so a long drain
  // isn't mistaken for a hung process.
  app.get("/healthz", (_req, res) => {
    if (platform.draining()) {
      res.status(503).json({ status: "draining" });
      return;
    }
    res.json({ status: "ok", version: options.version ?? "dev" });
  });
  app.get("/livez", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(express.json({ limit: "1mb" }));
  platform.install(app);

  app.get("/api/system/modules", (_req, res) => {
    const body: ModuleStatus[] = runtime.moduleStatus();
    res.json(body);
  });
  app.get("/api/system/jobs", (req, res) => {
    const user = platform.identify(req);
    if (!user || !platform.can(user, "admin")) {
      res.status(403).json({ error: "You don't have permission to do that." });
      return;
    }
    res.json(runtime.scheduler.list());
  });

  app.post("/api/system/reset", (req, res, next) => {
    const user = platform.identify(req);
    if (!user || !platform.can(user, "admin")) {
      res.status(403).json({ error: "You don't have permission to do that." });
      return;
    }
    runReset(
      { db: runtime.db, platform, registry: runtime.reset, log: runtime.log },
      parseResetRequest(req.body),
      user.id
    ).then((result) => res.json(result), next);
  });

  runtime.mountModules(app);

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found." });
  });
  app.use("/api", apiErrorHandler(runtime.log));

  if (options.publicDir) app.use(express.static(options.publicDir));
  return app;
}

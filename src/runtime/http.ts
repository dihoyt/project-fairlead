import type { ErrorRequestHandler, NextFunction, Request, Response, Router } from "express";
import { PUBLIC_ROUTES, type PublicRouteKey, type RouteKey } from "../contracts/api.js";
import type { RouteHandler } from "../contracts/routing.js";
import type { Logger } from "../contracts/runtime.js";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Method = "get" | "post" | "put" | "patch" | "delete";
const METHODS = new Set<string>(["get", "post", "put", "patch", "delete"]);

export function parseRouteKey(key: string): { method: Method; path: string } {
  const [verb, path, ...rest] = key.split(" ");
  const method = verb?.toLowerCase();
  if (!method || !METHODS.has(method) || !path?.startsWith("/") || rest.length > 0) {
    throw new Error(`Malformed route key "${key}".`);
  }
  return { method: method as Method, path };
}

// Binds a contract route on a module's router (mounted at /api/<moduleId>),
// refusing paths that belong to another module or the platform.
export function bindRoute<K extends RouteKey>(
  router: Router,
  moduleId: string,
  key: K,
  handler: RouteHandler<K>
): void {
  const { method, path } = parseRouteKey(key);
  const prefix = `/api/${moduleId}`;
  if (path !== prefix && !path.startsWith(`${prefix}/`)) {
    throw new Error(`Module "${moduleId}" cannot bind "${key}": its routes live under ${prefix}/.`);
  }
  const relative = path.slice(prefix.length) || "/";
  router[method](relative, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = await handler(req as never, res);
      if (body !== undefined && !res.headersSent) res.json(body);
    } catch (err) {
      next(err);
    }
  });
}

// Binds a PUBLIC_ROUTES entry on a module's public router (mounted at the
// app root), refusing one listed for another module or not listed at all.
export function bindPublicRoute<K extends PublicRouteKey>(
  router: Router,
  moduleId: string,
  key: K,
  handler: RouteHandler<K>,
  onError: ErrorRequestHandler
): void {
  const owner = (PUBLIC_ROUTES as Record<string, string>)[key];
  if (owner !== moduleId) {
    throw new Error(`Module "${moduleId}" cannot bind public route "${key}": PUBLIC_ROUTES doesn't list it for it.`);
  }
  const { method, path } = parseRouteKey(key);
  router[method](path, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = await handler(req as never, res);
      if (body !== undefined && !res.headersSent) res.json(body);
    } catch (err) {
      onError(err, req, res, next);
    }
  });
}

// Public routes answer in plain text: their callers are scripts, not the UI.
export function publicErrorHandler(log: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    res.type("text/plain");
    if (err instanceof HttpError) {
      res.status(err.status).send(`${err.message}\n`);
      return;
    }
    log.error("Unhandled public route error", {
      path: req.route?.path,
      error: err instanceof Error ? err.stack : String(err),
    });
    res.status(500).send("Internal error.\n");
  };
}

export function apiErrorHandler(log: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    // body-parser's own errors carry a status (400 bad JSON, 413 too large).
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({ error: (err as Error).message });
      return;
    }
    log.error("Unhandled API error", { path: req.path, error: err instanceof Error ? err.stack : String(err) });
    res.status(500).json({ error: "Internal error." });
  };
}

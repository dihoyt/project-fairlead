import type { ErrorRequestHandler, NextFunction, Request, Response, Router } from "express";
import { PUBLIC_ROUTES, type ApiRoutes, type PublicRouteKey, type RouteKey } from "../contracts/api.js";
import type { CallInput } from "../contracts/module.js";
import { INTERNAL_CALL_HEADER, type Platform } from "../contracts/platform.js";
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

// The route's path with its params filled in and its query appended.
export function routeUrl(key: RouteKey, input: CallInput<RouteKey> = {}): { method: string; path: string } {
  const { method, path } = parseRouteKey(key);
  const params = (input.params ?? {}) as Record<string, string>;
  const filled = path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Route "${key}" needs param "${name}".`);
    return encodeURIComponent(value);
  });
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries((input.query ?? {}) as Record<string, unknown>)) {
    if (value !== undefined) query.set(name, String(value));
  }
  const search = query.toString();
  return { method: method.toUpperCase(), path: search ? `${filled}?${search}` : filled };
}

// The request goes back in over the socket the caller's request arrived on,
// so it reaches this same process whatever address the server is bound to,
// and passes through every middleware a request from outside would.
export async function callRoute<K extends RouteKey>(
  platform: Platform,
  req: Request,
  key: K,
  input?: CallInput<K>
): Promise<ApiRoutes[K]["response"]> {
  const { method, path } = routeUrl(key, input as CallInput<RouteKey>);
  const address = req.socket.localAddress ?? "127.0.0.1";
  const host = address.includes(":") ? `[${address}]` : address;
  const headers: Record<string, string> = { [INTERNAL_CALL_HEADER]: platform.vouch(req) };
  let body: string | undefined;
  if (input?.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(input.body);
  }
  const res = await fetch(`http://${host}:${req.socket.localPort}${path}`, { method, headers, body });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    const message = (parsed as { error?: unknown } | undefined)?.error;
    throw new HttpError(res.status, typeof message === "string" ? message : `${key} answered ${res.status}.`);
  }
  return parsed as ApiRoutes[K]["response"];
}

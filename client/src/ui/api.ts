// Typed access to every route in ApiRoutes, keyed by the same
// "METHOD /path" strings the server binds, so a page can only call a route
// the contract has and gets its response type for free.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiRoutes, EventStream, RouteKey, TextBody } from "@contracts/api";

export type { ApiRoutes, RouteKey };

// Event streams are read with EventSource (see `routeUrl`), not fetched.
export type FetchRouteKey = {
  [K in RouteKey]: ApiRoutes[K]["response"] extends EventStream<unknown> ? never : K;
}[RouteKey];

export type ApiResult<K extends RouteKey> =
  ApiRoutes[K]["response"] extends TextBody<string> ? string : ApiRoutes[K]["response"];

// The contract spells "no params/query/body" as Record<string, never>.
type Empty<T> = string extends keyof T ? true : false;
type Field<Name extends string, T> = Empty<T> extends true ? { [P in Name]?: undefined } : { [P in Name]: T };

export type RouteArgs<K extends RouteKey> = Field<"params", ApiRoutes[K]["params"]> &
  (Empty<ApiRoutes[K]["query"]> extends true
    ? { query?: undefined }
    : { query?: { [Q in keyof ApiRoutes[K]["query"]]?: ApiRoutes[K]["query"][Q] } }) &
  Field<"body", ApiRoutes[K]["body"]> & { signal?: AbortSignal };

// The args parameter is optional only for routes that need none.
type ArgsParam<K extends RouteKey> =
  Empty<ApiRoutes[K]["params"]> extends true
    ? Empty<ApiRoutes[K]["body"]> extends true
      ? [args?: RouteArgs<K>]
      : [args: RouteArgs<K>]
    : [args: RouteArgs<K>];

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// Dispatched when a request finds the session gone (401/403 outside the
// sign-in routes); the auth gate listens and re-checks who is signed in,
// so no page has to handle an expired session itself.
export const AUTH_CHANGED = "app:auth-changed";

// Relative to the document, never root-relative: the app may be served
// under a path prefix, and "/api/..." would resolve past it.
export function resolve(path: string): URL {
  return new URL(path.replace(/^\//, ""), document.baseURI);
}

// A browser navigation rather than a fetch (OIDC start, CSV download).
export function pageUrl(path: string): string {
  return resolve(path).toString();
}

export function splitKey(key: RouteKey): { method: string; path: string } {
  const space = key.indexOf(" ");
  return { method: key.slice(0, space), path: key.slice(space + 1) };
}

export function routeUrl<K extends RouteKey>(
  key: K,
  args?: { params?: ApiRoutes[K]["params"]; query?: Partial<ApiRoutes[K]["query"]> }
): URL {
  const { path } = splitKey(key);
  const params = (args?.params ?? {}) as Record<string, string>;
  const filled = path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`${key}: missing path parameter "${name}"`);
    return encodeURIComponent(value);
  });
  const url = resolve(filled);
  for (const [name, value] of Object.entries((args?.query ?? {}) as Record<string, string | undefined>)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url;
}

const SIGN_IN_ROUTES = /^\/api\/(me|auth\/)/;

export async function apiRequest<K extends FetchRouteKey>(key: K, ...[args]: ArgsParam<K>): Promise<ApiResult<K>> {
  const { method, path } = splitKey(key);
  const url = routeUrl(key, args as Parameters<typeof routeUrl<K>>[1]);
  const body = (args as { body?: unknown } | undefined)?.body;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      signal: args?.signal,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    if ((cause as Error)?.name === "AbortError") throw cause;
    throw new ApiError(0, "Could not reach the server.");
  }

  if (!res.ok) {
    // The gate's own calls are exempt, or a signed-out /api/me would
    // announce a change that triggers another /api/me, forever.
    if ((res.status === 401 || res.status === 403) && !SIGN_IN_ROUTES.test(path)) {
      window.dispatchEvent(new Event(AUTH_CHANGED));
    }
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, payload?.error || `Request failed (${res.status})`);
  }

  const type = res.headers.get("content-type") ?? "";
  return (type.includes("application/json") ? await res.json() : await res.text()) as ApiResult<K>;
}

export interface ApiResource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  // Refetch now, e.g. after a mutation elsewhere on the page.
  reload: () => void;
}

export interface UseApiOptions {
  pollMs?: number;
  // false holds the request, e.g. until a selection exists.
  enabled?: boolean;
}

// GET a route and keep it fresh. On a failed refresh the last good data is
// kept alongside the error rather than blanking the page.
export function useApi<K extends FetchRouteKey>(
  key: K,
  args?: Omit<RouteArgs<K>, "signal" | "body">,
  options: UseApiOptions = {}
): ApiResource<ApiResult<K>> {
  const { pollMs, enabled = true } = options;
  const argsKey = JSON.stringify(args ?? {});
  const [data, setData] = useState<ApiResult<K> | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(0);
  const reload = useCallback(() => setToken((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // A tick that finds the previous request still in flight is dropped,
    // so a slow server never accumulates a backlog.
    let inFlight = false;
    const controller = new AbortController();
    const parsed = JSON.parse(argsKey) as RouteArgs<K>;

    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await (apiRequest as (k: K, a: RouteArgs<K>) => Promise<ApiResult<K>>)(key, {
          ...parsed,
          signal: controller.signal,
        });
        if (cancelled) return;
        setData(next);
        setError(null);
      } catch (err) {
        if (cancelled || (err as Error)?.name === "AbortError") return;
        setError((err as Error).message || "Request failed");
      } finally {
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const timer = pollMs ? window.setInterval(() => void load(), pollMs) : undefined;
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [key, argsKey, pollMs, enabled, token]);

  return useMemo(() => ({ data, loading, error, reload }), [data, loading, error, reload]);
}

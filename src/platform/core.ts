import type { Request, RequestHandler, Response } from "express";
import type { Database } from "better-sqlite3";
import type { PublicUrlView } from "../contracts/auth.js";
import type { Logger } from "../contracts/runtime.js";
import type { PlatformAudit } from "./audit.js";
import type { FailureLimiter } from "./auth/limiter.js";
import { inAny, normalizeIp, proxyTrustFromEnv } from "./net.js";
import type { PlatformSecrets } from "./secrets.js";
import type { PlatformSettings } from "./settings.js";

// What every part of the platform works against: one per createPlatform, so
// tests get a fresh one each and nothing lives in module-level state.
export interface Core {
  db: Database;
  orgId: string;
  settings: PlatformSettings;
  secrets: PlatformSecrets;
  audit: PlatformAudit;
  log: Logger;
  limits: { byUser: FailureLimiter; byIp: FailureLimiter };
}

const trimOrigin = (raw: string): string => raw.trim().replace(/\/+$/, "");

// Only the deployment's own value: what decides Secure cookies, so that a
// value saved from the UI can never make the browser drop the session.
export function envPublicOrigin(): string {
  return trimOrigin(process.env.PUBLIC_ORIGIN ?? "");
}

// The configured public URL: PUBLIC_ORIGIN when set, else the one saved in
// settings, else "".
export function publicOrigin(core: Pick<Core, "settings">): string {
  return trimOrigin(core.settings.string("site.publicUrl"));
}

function forwarded(req: Request, name: string): string {
  return (req.get(name) ?? "").split(",")[0]!.trim();
}

// The address this request was sent to, as the browser saw it. Forwarded
// scheme and host are believed only from a peer named in TRUSTED_PROXIES,
// the same rule clientIp() applies to forwarded addresses.
export function requestOrigin(req: Request): string {
  const trust = proxyTrustFromEnv();
  const peer = normalizeIp(req.socket?.remoteAddress ?? "");
  const viaProxy = inAny(trust.proxies, peer);
  const proto = (viaProxy && forwarded(req, "x-forwarded-proto")) || req.protocol;
  const host = (viaProxy && forwarded(req, "x-forwarded-host")) || req.get("host") || "";
  return host ? `${proto}://${host}` : "";
}

export function effectivePublicUrl(core: Pick<Core, "settings">, req: Request): PublicUrlView {
  const configured = publicOrigin(core);
  if (configured) return { value: configured, source: core.settings.source("site.publicUrl") === "env" ? "env" : "ui" };
  return { value: requestOrigin(req), source: "request" };
}

export const iso = (ms: number): string => new Date(ms).toISOString();
export const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));

// Express 4 ignores a handler's returned promise, so a rejection would
// escape as an unhandled one and take the process down. Async handlers go
// through here, which passes the rejection to next() instead.
export function handle(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

import type { Request, RequestHandler, Response } from "express";
import type { Database } from "better-sqlite3";
import type { Logger } from "../contracts/runtime.js";
import type { PlatformAudit } from "./audit.js";
import type { FailureLimiter } from "./auth/limiter.js";
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

export function publicOrigin(): string {
  return (process.env.PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "");
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

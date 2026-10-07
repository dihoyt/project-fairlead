import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { SignInMethod } from "../../contracts/platform.js";
import { sessionCookieName } from "../../product.js";
import { publicOrigin, type Core } from "../core.js";

export interface SessionRow {
  idHash: string;
  userId: number;
  method: SignInMethod;
  groups: string[];
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string;
  userAgent: string;
  // When an OIDC session last went back through the provider; null until
  // the first re-check (the sign-in itself counts as createdAt).
  oidcCheckedAt: number | null;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// last_seen_at is a write per request otherwise; once a minute is enough
// for "signed out after N idle days" and keeps the database quiet.
const TOUCH_EVERY = 60 * 1000;

// Secure cookies (and the __Host- prefix that requires them) only when the
// install is actually served over https; a plain-http local run would
// otherwise set a cookie the browser then refuses to send back.
function secure(): boolean {
  return publicOrigin().startsWith("https://");
}

export function cookieName(): string {
  return secure() ? `__Host-${sessionCookieName}` : sessionCookieName;
}

export function readCookie(req: Request, name: string): string {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return "";
      }
    }
  }
  return "";
}

function hash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// The public handle for a session in the admin UI: enough to tell rows
// apart and revoke one, and useless as a cookie.
export function sessionHandle(idHash: string): string {
  return idHash.slice(0, 16);
}

function idleMs(core: Core): number {
  return core.settings.number("auth.session.idleDays") * DAY;
}

function setCookie(res: Response, value: string, maxAgeMs: number): void {
  const attributes = [
    `${cookieName()}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    // Lax, not Strict: the OIDC callback arrives as a top-level navigation
    // from the provider's site, and the session cookie set on that response
    // has to be sent on the redirect that follows it.
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
  ];
  if (secure()) attributes.push("Secure");
  res.append("Set-Cookie", attributes.join("; "));
}

export function createSession(
  core: Core,
  res: Response,
  input: { userId: number; method: SignInMethod; groups?: string[]; ip: string; userAgent: string }
): void {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  core.db
    .prepare(
      `INSERT INTO sessions (id_hash, org_id, user_id, method, groups, created_at, last_seen_at, expires_at, ip, user_agent, oidc_checked_at)
       SELECT ?, org_id, id, ?, ?, ?, ?, ?, ?, ?, ? FROM users WHERE id = ?`
    )
    .run(
      hash(token),
      input.method,
      JSON.stringify(input.groups ?? []),
      now,
      now,
      now + idleMs(core),
      input.ip,
      input.userAgent.slice(0, 300),
      input.method === "oidc" ? now : null,
      input.userId
    );
  setCookie(res, token, idleMs(core));
}

interface RawSession {
  id_hash: string;
  user_id: number;
  method: SignInMethod;
  groups: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  ip: string;
  user_agent: string;
  oidc_checked_at: number | null;
}

function fromRaw(raw: RawSession): SessionRow {
  let groups: string[] = [];
  try {
    const parsed: unknown = JSON.parse(raw.groups);
    if (Array.isArray(parsed)) groups = parsed.filter((g): g is string => typeof g === "string");
  } catch {
    // An unreadable groups column grants no groups.
  }
  return {
    idHash: raw.id_hash,
    userId: raw.user_id,
    method: raw.method,
    groups,
    createdAt: raw.created_at,
    lastSeenAt: raw.last_seen_at,
    expiresAt: raw.expires_at,
    ip: raw.ip,
    userAgent: raw.user_agent,
    oidcCheckedAt: raw.oidc_checked_at ?? null,
  };
}

// Rules beyond the idle expiry that end a session.
//
// "expired": older than auth.session.maxDays, however active it has been.
// "recheck": an OIDC session that has not been back through the provider
// for auth.oidc.recheckHours. A re-check is an ordinary OIDC sign-in that
// replaces the session, so a session's last check is its creation and it
// never becomes fresh again in place.
export type SessionStanding = "ok" | "expired" | "recheck";

export function sessionStanding(core: Core, session: SessionRow, now = Date.now()): SessionStanding {
  if (now - session.createdAt > core.settings.number("auth.session.maxDays") * DAY) return "expired";
  const recheckHours = core.settings.number("auth.oidc.recheckHours");
  const checkedAt = session.oidcCheckedAt ?? session.createdAt;
  if (recheckHours > 0 && session.method === "oidc" && now - checkedAt > recheckHours * HOUR) return "recheck";
  return "ok";
}

function rawByToken(core: Core, token: string): RawSession | undefined {
  return core.db.prepare("SELECT * FROM sessions WHERE id_hash = ?").get(hash(token)) as RawSession | undefined;
}

// Looks the cookie up and slides its expiry forward. An expired row is
// deleted on sight rather than left for a sweeper, since this is the only
// place that would ever read it. With no response (an identify() outside
// the request pipeline) nothing is written.
export function sessionFromRequest(core: Core, req: Request, res: Response | null, ip: string): SessionRow | null {
  const token = readCookie(req, cookieName());
  if (!token) return null;
  const raw = rawByToken(core, token);
  if (raw === undefined) return null;
  const now = Date.now();
  const standing = raw.expires_at <= now ? "expired" : sessionStanding(core, fromRaw(raw), now);
  if (standing === "expired") {
    if (res !== null) core.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(raw.id_hash);
    return null;
  }
  // Kept until the re-check replaces it or fails, so that a request can
  // still be told a re-check is what it needs (sessionDueRecheck).
  if (standing === "recheck") return null;
  if (res !== null && now - raw.last_seen_at > TOUCH_EVERY) {
    const expiresAt = now + idleMs(core);
    core.db
      .prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ?, ip = ? WHERE id_hash = ?")
      .run(now, expiresAt, ip, raw.id_hash);
    setCookie(res, token, idleMs(core));
    return fromRaw({ ...raw, last_seen_at: now, expires_at: expiresAt, ip });
  }
  return fromRaw(raw);
}

// The request's session when the only thing wrong with it is an overdue
// OIDC re-check: what lets a 401 say "go back through the provider"
// rather than "sign in".
export function sessionDueRecheck(core: Core, req: Request, now = Date.now()): SessionRow | null {
  const token = readCookie(req, cookieName());
  if (!token) return null;
  const raw = rawByToken(core, token);
  if (raw === undefined || raw.expires_at <= now) return null;
  const session = fromRaw(raw);
  return sessionStanding(core, session, now) === "recheck" ? session : null;
}

// Deletes the request's session row and leaves its cookie alone, for a
// response that sets a new cookie of its own.
export function dropRequestSession(core: Core, req: Request): void {
  const token = readCookie(req, cookieName());
  if (token) core.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(hash(token));
}

export function endSession(core: Core, req: Request, res: Response): void {
  dropRequestSession(core, req);
  setCookie(res, "", 0);
}

export function sessionsOf(core: Core, userId: number): SessionRow[] {
  return (
    core.db
      .prepare("SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC")
      .all(userId, Date.now()) as RawSession[]
  ).map(fromRaw);
}

export function revokeSession(core: Core, userId: number, handle: string): boolean {
  const rows = sessionsOf(core, userId).filter((session) => sessionHandle(session.idHash) === handle);
  for (const row of rows) core.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(row.idHash);
  return rows.length > 0;
}

// `except` keeps the caller's own session, for "sign out everywhere else"
// after a password change.
export function revokeAllSessions(core: Core, userId: number, except?: string): number {
  if (except === undefined) return core.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId).changes;
  return core.db.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?").run(userId, except).changes;
}

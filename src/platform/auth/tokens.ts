import crypto from "node:crypto";
import type { Request } from "express";
import type { ApiTokenScope, ApiTokenView } from "../../contracts/auth.js";
import { iso, isoOrNull, type Core } from "../core.js";
import { userById, type UserRow } from "./users.js";

// A token is "api_" and 32 random bytes. It is high-entropy, so a plain
// hash is enough to store it: there is nothing to brute-force.
const PREFIX = "api_";
const PREFIX_SHOWN = PREFIX.length + 4;
const DAY = 24 * 60 * 60 * 1000;
// last_used_at would be a write per request otherwise.
const TOUCH_EVERY = 60 * 1000;

interface RawToken {
  id: string;
  secret_hash: string;
  prefix: string;
  name: string;
  scope: ApiTokenScope;
  user_id: number;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  kind?: "token" | "oauth";
  client_id?: string | null;
  access_expires_at?: number | null;
}

export interface TokenRow {
  id: string;
  prefix: string;
  name: string;
  scope: ApiTokenScope;
  userId: number;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  kind: "token" | "oauth";
  clientId: string | null;
}

export const hash = (secret: string) => crypto.createHash("sha256").update(secret).digest("hex");

function fromRaw(raw: RawToken): TokenRow {
  return {
    id: raw.id,
    prefix: raw.prefix,
    name: raw.name,
    scope: raw.scope,
    userId: raw.user_id,
    createdAt: raw.created_at,
    expiresAt: raw.expires_at,
    lastUsedAt: raw.last_used_at,
    kind: raw.kind ?? "token",
    clientId: raw.client_id ?? null,
  };
}

// The bearer token on a request: undefined when there is no Authorization
// header, "" when there is one that isn't a bearer token of ours.
export function bearerOf(req: Request): string | undefined {
  const header = req.get("authorization");
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match && match[1]!.startsWith(PREFIX) ? match[1]! : "";
}

export const newSecret = (): string => PREFIX + crypto.randomBytes(32).toString("base64url");
export const secretPrefix = (secret: string): string => secret.slice(0, PREFIX_SHOWN);

export function createToken(
  core: Core,
  input: {
    name: string;
    scope: ApiTokenScope;
    userId: number;
    expiresInDays: number | null;
    // An OAuth grant: the client and when its access token expires.
    oauth?: { clientId: string; accessExpiresAt: number; refreshHash: string };
  }
): { row: TokenRow; secret: string } {
  const secret = newSecret();
  const now = Date.now();
  const raw: RawToken = {
    id: `tok_${crypto.randomBytes(9).toString("base64url")}`,
    secret_hash: hash(secret),
    prefix: secretPrefix(secret),
    name: input.name,
    scope: input.scope,
    user_id: input.userId,
    created_at: now,
    expires_at: input.expiresInDays === null ? null : now + input.expiresInDays * DAY,
    last_used_at: null,
    kind: input.oauth ? "oauth" : "token",
    client_id: input.oauth?.clientId ?? null,
    access_expires_at: input.oauth?.accessExpiresAt ?? null,
  };
  core.db
    .prepare(
      `INSERT INTO api_tokens (id, org_id, secret_hash, prefix, name, scope, user_id, created_at, expires_at, last_used_at,
         kind, client_id, refresh_hash, access_expires_at)
       VALUES (@id, ?, @secret_hash, @prefix, @name, @scope, @user_id, @created_at, @expires_at, @last_used_at,
         @kind, @client_id, ?, @access_expires_at)`
    )
    .run(core.orgId, input.oauth?.refreshHash ?? null, raw);
  return { row: fromRaw(raw), secret };
}

export function listTokens(core: Core): TokenRow[] {
  return (core.db.prepare("SELECT * FROM api_tokens ORDER BY created_at DESC, id").all() as RawToken[]).map(fromRaw);
}

export function revokeToken(core: Core, id: string): TokenRow | null {
  const raw = core.db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(id) as RawToken | undefined;
  if (raw === undefined) return null;
  core.db.prepare("DELETE FROM api_tokens WHERE id = ?").run(id);
  return fromRaw(raw);
}

// The live token and its account for a secret; null for an unknown or
// expired token or a disabled account. Touches last_used_at.
export function tokenFromSecret(
  core: Core,
  secret: string,
  now = Date.now()
): { token: TokenRow; account: UserRow } | null {
  if (!secret) return null;
  const raw = core.db.prepare("SELECT * FROM api_tokens WHERE secret_hash = ?").get(hash(secret)) as
    RawToken | undefined;
  if (raw === undefined) return null;
  if (raw.expires_at !== null && raw.expires_at <= now) return null;
  if (raw.access_expires_at != null && raw.access_expires_at <= now) return null;
  const account = userById(core.db, raw.user_id);
  if (account === null || account.disabled) return null;
  if (raw.last_used_at === null || now - raw.last_used_at > TOUCH_EVERY) {
    core.db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now, raw.id);
    raw.last_used_at = now;
  }
  return { token: fromRaw(raw), account };
}

export function tokenView(
  core: Core,
  row: TokenRow,
  isAdmin: (account: UserRow) => boolean,
  now = Date.now()
): ApiTokenView {
  const account = userById(core.db, row.userId);
  let inactive: string | undefined;
  if (row.expiresAt !== null && row.expiresAt <= now) inactive = "Expired.";
  else if (account === null || account.disabled) inactive = "The account it acts as is disabled.";
  else if (!isAdmin(account)) inactive = "The account it acts as is no longer an admin, so it can only read.";
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    prefix: row.prefix,
    createdBy: account?.username ?? "",
    createdAt: iso(row.createdAt),
    expiresAt: isoOrNull(row.expiresAt),
    lastUsedAt: isoOrNull(row.lastUsedAt),
    ...(inactive ? { inactive } : {}),
    ...(row.kind === "oauth" ? { kind: "oauth" as const, client: row.name } : {}),
  };
}

import crypto from "node:crypto";
import type { Request } from "express";
import type { ApiTokenScope, ApiTokenView } from "../../contracts/auth.js";
import { TOKEN_AREAS, type ApiTokenGrant, type TokenArea } from "../../contracts/grants.js";
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
  namespaces?: string | null;
  areas?: string | null;
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
  namespaces?: string[];
  areas?: TokenArea[];
  kind: "token" | "oauth";
  clientId: string | null;
}

// A grant's limits as stored: a JSON array, or NULL for every one.
function parseList<T extends string>(text: string | null | undefined, allowed?: readonly string[]): T[] | undefined {
  if (text == null) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value)) {
      const items = value.filter((v): v is T => typeof v === "string" && (!allowed || allowed.includes(v)));
      // A stored list that lost every entry still limits: it reaches nothing
      // rather than everything.
      return items;
    }
  } catch {
    // fall through
  }
  return [];
}

const storeList = (list: readonly string[] | undefined): string | null =>
  list === undefined ? null : JSON.stringify(list);

const NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const MAX_NAMESPACES = 100;

function limitList(value: unknown, what: string, valid: (item: string) => boolean): string[] | null | undefined {
  if (value === undefined || value === null) return value;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Pick at least one of the ${what}, or leave the token reaching all of them.`);
  }
  const items = [...new Set(value.map((item) => (typeof item === "string" ? item.trim() : "")))];
  const bad = items.find((item) => !valid(item));
  if (bad !== undefined) throw new Error(`"${bad}" is not one of the ${what}.`);
  return items;
}

// A request's namespaces or areas: undefined when absent (unchanged on an
// edit), null for every one, else the de-duplicated list. Throws a sentence
// naming what is wrong.
export function limitsOf(body: Record<string, unknown>): {
  namespaces: string[] | null | undefined;
  areas: TokenArea[] | null | undefined;
} {
  const namespaces = limitList(body.namespaces, "namespaces", (item) => NAMESPACE.test(item));
  if (namespaces && namespaces.length > MAX_NAMESPACES) {
    throw new Error(`A token can name up to ${MAX_NAMESPACES} namespaces.`);
  }
  const areas = limitList(body.areas, "areas", (item) => (TOKEN_AREAS as readonly string[]).includes(item));
  return { namespaces, areas: areas as TokenArea[] | null | undefined };
}

export function grantOf(row: TokenRow): ApiTokenGrant {
  return {
    scope: row.scope,
    ...(row.namespaces ? { namespaces: row.namespaces } : {}),
    ...(row.areas ? { areas: row.areas } : {}),
  };
}

export const hash = (secret: string) => crypto.createHash("sha256").update(secret).digest("hex");

const optional = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

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
    ...optional("namespaces", parseList<string>(raw.namespaces)),
    ...optional("areas", parseList<TokenArea>(raw.areas, TOKEN_AREAS)),
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
    namespaces?: string[];
    areas?: TokenArea[];
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
    namespaces: storeList(input.namespaces),
    areas: storeList(input.areas),
    kind: input.oauth ? "oauth" : "token",
    client_id: input.oauth?.clientId ?? null,
    access_expires_at: input.oauth?.accessExpiresAt ?? null,
  };
  core.db
    .prepare(
      `INSERT INTO api_tokens (id, org_id, secret_hash, prefix, name, scope, user_id, created_at, expires_at, last_used_at,
         namespaces, areas, kind, client_id, refresh_hash, access_expires_at)
       VALUES (@id, ?, @secret_hash, @prefix, @name, @scope, @user_id, @created_at, @expires_at, @last_used_at,
         @namespaces, @areas, @kind, @client_id, ?, @access_expires_at)`
    )
    .run(core.orgId, input.oauth?.refreshHash ?? null, raw);
  return { row: fromRaw(raw), secret };
}

export function listTokens(core: Core): TokenRow[] {
  return (core.db.prepare("SELECT * FROM api_tokens ORDER BY created_at DESC, id").all() as RawToken[]).map(fromRaw);
}

// Applies the changes given; undefined leaves a field alone, null in
// namespaces or areas removes that limit. Null for an unknown id.
export function updateToken(
  core: Core,
  id: string,
  changes: { name?: string; scope?: ApiTokenScope; namespaces?: string[] | null; areas?: TokenArea[] | null }
): TokenRow | null {
  const raw = core.db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(id) as RawToken | undefined;
  if (raw === undefined) return null;
  const next: RawToken = {
    ...raw,
    ...(changes.name !== undefined ? { name: changes.name } : {}),
    ...(changes.scope !== undefined ? { scope: changes.scope } : {}),
    ...(changes.namespaces !== undefined ? { namespaces: storeList(changes.namespaces ?? undefined) } : {}),
    ...(changes.areas !== undefined ? { areas: storeList(changes.areas ?? undefined) } : {}),
  };
  core.db
    .prepare(
      "UPDATE api_tokens SET name = @name, scope = @scope, namespaces = @namespaces, areas = @areas WHERE id = @id"
    )
    .run({ id, name: next.name, scope: next.scope, namespaces: next.namespaces ?? null, areas: next.areas ?? null });
  return fromRaw(next);
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
    ...optional("namespaces", row.namespaces),
    ...optional("areas", row.areas),
    prefix: row.prefix,
    createdBy: account?.username ?? "",
    createdAt: iso(row.createdAt),
    expiresAt: isoOrNull(row.expiresAt),
    lastUsedAt: isoOrNull(row.lastUsedAt),
    ...(inactive ? { inactive } : {}),
    ...(row.kind === "oauth" ? { kind: "oauth" as const, client: row.name } : {}),
  };
}

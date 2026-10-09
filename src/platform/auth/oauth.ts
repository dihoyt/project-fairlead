import crypto from "node:crypto";
import type { ApiTokenScope, OAuthAuthorizeParams } from "../../contracts/auth.js";
import type { TokenArea } from "../../contracts/grants.js";
import type { Core } from "../core.js";
import { createToken, hash, newSecret, secretPrefix, type TokenRow } from "./tokens.js";
import { userById } from "./users.js";

// The authorization server behind /mcp: public clients only, authorization
// code with PKCE S256, rotating refresh tokens. Every grant is an api_tokens
// row, so it is listed and revoked with the tokens made by hand.

export const CODE_TTL_MS = 10 * 60 * 1000;
export const ACCESS_TTL_MS = 60 * 60 * 1000;
const MAX_CLIENTS = 500;
// Registration is open, so clients that never got a grant are dropped
// after a day to keep the table from filling up.
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_PREFIX = "apr_";

// The error codes RFC 6749 names; the routes turn them into the response
// the endpoint calls for (JSON from /oauth/token, a redirect from /authorize).
export class OAuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, description: string, status = 400) {
    super(description);
    this.code = code;
    this.status = status;
  }
}

export interface OAuthClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  createdAt: number;
}

interface RawClient {
  client_id: string;
  name: string;
  redirect_uris: string;
  created_at: number;
}

const fromRaw = (raw: RawClient): OAuthClient => ({
  clientId: raw.client_id,
  name: raw.name,
  redirectUris: JSON.parse(raw.redirect_uris) as string[],
  createdAt: raw.created_at,
});

// https anywhere; plain http only back to this machine (CLI clients that
// listen on a loopback port). No fragments, no credentials.
export function redirectUriProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return "Redirect URIs must be URLs.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `"${raw}" is not a URL.`;
  }
  if (url.hash || url.username || url.password) return `"${raw}" may not carry a fragment or credentials.`;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return null;
  return `"${raw}" must be https, or http on localhost.`;
}

export function registerClient(core: Core, input: { name: string; redirectUris: string[] }): OAuthClient {
  const now = Date.now();
  core.db
    .prepare(
      `DELETE FROM oauth_clients WHERE created_at < ?
         AND client_id NOT IN (SELECT client_id FROM api_tokens WHERE client_id IS NOT NULL)`
    )
    .run(now - UNUSED_CLIENT_TTL_MS);
  const { count } = core.db.prepare("SELECT COUNT(*) AS count FROM oauth_clients").get() as { count: number };
  if (count >= MAX_CLIENTS) {
    throw new OAuthError("temporarily_unavailable", "Too many registered clients; try again later.", 503);
  }
  const client: OAuthClient = {
    clientId: `cli_${crypto.randomBytes(12).toString("base64url")}`,
    name: input.name,
    redirectUris: input.redirectUris,
    createdAt: now,
  };
  core.db
    .prepare("INSERT INTO oauth_clients (client_id, org_id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(client.clientId, core.orgId, client.name, JSON.stringify(client.redirectUris), now);
  return client;
}

export function clientById(core: Core, clientId: string): OAuthClient | null {
  const raw = core.db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId) as RawClient | undefined;
  return raw ? fromRaw(raw) : null;
}

export function scopeOf(raw: string | undefined): ApiTokenScope {
  return (raw ?? "").split(/\s+/).includes("write") ? "write" : "read";
}

// Everything an authorization request has to satisfy before anyone is
// asked to approve it. An unknown client or redirect URI is never sent
// back to that URI (it could be anyone's); the rest can be.
export function checkAuthorizeRequest(
  core: Core,
  params: Partial<OAuthAuthorizeParams>,
  resource: string
): { client: OAuthClient; redirectUri: string } {
  const client = typeof params.client_id === "string" ? clientById(core, params.client_id) : null;
  if (client === null) throw new OAuthError("invalid_client", "Unknown client. Register it first.");
  if (typeof params.redirect_uri !== "string" || !client.redirectUris.includes(params.redirect_uri)) {
    // Not an RFC code: it is never sent to the redirect URI, only shown.
    throw new OAuthError("invalid_redirect_uri", "The redirect URI isn't one this client registered.");
  }
  if (params.response_type !== "code") {
    throw new OAuthError("unsupported_response_type", "Only response_type=code is supported.");
  }
  if (params.code_challenge_method !== "S256" || typeof params.code_challenge !== "string") {
    throw new OAuthError("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(params.code_challenge)) {
    throw new OAuthError("invalid_request", "code_challenge is not an S256 challenge.");
  }
  if (params.resource !== undefined && params.resource.replace(/\/+$/, "") !== resource) {
    throw new OAuthError("invalid_target", `This server only issues tokens for ${resource}.`);
  }
  return { client, redirectUri: params.redirect_uri };
}

export function redirectWith(redirectUri: string, values: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
}

export function issueCode(
  core: Core,
  input: {
    clientId: string;
    userId: number;
    scope: ApiTokenScope;
    namespaces?: string[];
    areas?: TokenArea[];
    redirectUri: string;
    codeChallenge: string;
  }
): string {
  const code = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  core.db.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").run(now);
  core.db
    .prepare(
      `INSERT INTO oauth_codes (code_hash, org_id, client_id, user_id, scope, namespaces, areas, redirect_uri,
         code_challenge, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      hash(code),
      core.orgId,
      input.clientId,
      input.userId,
      input.scope,
      input.namespaces ? JSON.stringify(input.namespaces) : null,
      input.areas ? JSON.stringify(input.areas) : null,
      input.redirectUri,
      input.codeChallenge,
      now + CODE_TTL_MS
    );
  return code;
}

export interface IssuedTokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: ApiTokenScope;
}

const issued = (secret: string, refresh: string, scope: ApiTokenScope): IssuedTokens => ({
  access_token: secret,
  token_type: "Bearer",
  expires_in: ACCESS_TTL_MS / 1000,
  refresh_token: refresh,
  scope,
});

const s256 = (verifier: string) => crypto.createHash("sha256").update(verifier).digest("base64url");

const sameText = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

export function exchangeCode(
  core: Core,
  input: { code: string; clientId: string; redirectUri: string; codeVerifier: string }
): { tokens: IssuedTokens; grant: TokenRow } {
  const row = core.db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(hash(input.code)) as
    | {
        client_id: string;
        user_id: number;
        scope: ApiTokenScope;
        namespaces: string | null;
        areas: string | null;
        redirect_uri: string;
        code_challenge: string;
        expires_at: number;
      }
    | undefined;
  // Spent whether or not the rest checks out: a code is tried once.
  core.db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(hash(input.code));
  if (!row || row.expires_at <= Date.now())
    throw new OAuthError("invalid_grant", "The code is unknown, used or expired.");
  if (row.client_id !== input.clientId || row.redirect_uri !== input.redirectUri) {
    throw new OAuthError("invalid_grant", "The code was issued to another client or redirect URI.");
  }
  if (
    !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier) ||
    !sameText(s256(input.codeVerifier), row.code_challenge)
  ) {
    throw new OAuthError("invalid_grant", "code_verifier doesn't match the code_challenge.");
  }
  const account = userById(core.db, row.user_id);
  if (account === null || account.disabled) throw new OAuthError("invalid_grant", "The approving account is disabled.");
  const client = clientById(core, row.client_id);
  const refresh = REFRESH_PREFIX + crypto.randomBytes(32).toString("base64url");
  const { row: grant, secret } = createToken(core, {
    name: client?.name ?? "OAuth client",
    scope: row.scope,
    ...(row.namespaces ? { namespaces: JSON.parse(row.namespaces) as string[] } : {}),
    ...(row.areas ? { areas: JSON.parse(row.areas) as TokenArea[] } : {}),
    userId: row.user_id,
    expiresInDays: null,
    oauth: { clientId: row.client_id, accessExpiresAt: Date.now() + ACCESS_TTL_MS, refreshHash: hash(refresh) },
  });
  return { tokens: issued(secret, refresh, row.scope), grant };
}

export function refreshGrant(core: Core, input: { refreshToken: string; clientId: string }): IssuedTokens {
  const raw = core.db
    .prepare("SELECT id, user_id, scope, client_id FROM api_tokens WHERE refresh_hash = ?")
    .get(hash(input.refreshToken)) as
    { id: string; user_id: number; scope: ApiTokenScope; client_id: string } | undefined;
  if (!raw || raw.client_id !== input.clientId)
    throw new OAuthError("invalid_grant", "The refresh token is unknown or revoked.");
  const account = userById(core.db, raw.user_id);
  if (account === null || account.disabled) throw new OAuthError("invalid_grant", "The approving account is disabled.");
  const secret = newSecret();
  const refresh = REFRESH_PREFIX + crypto.randomBytes(32).toString("base64url");
  core.db
    .prepare("UPDATE api_tokens SET secret_hash = ?, prefix = ?, refresh_hash = ?, access_expires_at = ? WHERE id = ?")
    .run(hash(secret), secretPrefix(secret), hash(refresh), Date.now() + ACCESS_TTL_MS, raw.id);
  return issued(secret, refresh, raw.scope);
}

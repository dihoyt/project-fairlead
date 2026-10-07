import crypto from "node:crypto";
import { publicOrigin, type Core } from "../core.js";
import { SecretKeyError } from "../secretBox.js";

// OpenID Connect, authorization code flow with PKCE, against any provider
// that publishes discovery metadata. Written against the spec rather than
// pulled in as a library: the flow itself is a few requests.
//
// The ID token's signature is not verified, deliberately: it is received
// directly from the token endpoint over TLS in exchange for the client
// secret, which OIDC Core 3.1.3.7 (6) allows in place of checking it. Its
// claims are still checked — issuer, audience, nonce, expiry — because
// those say whether it was issued to this client for this sign-in.

export const CALLBACK_PATH = "/auth/oidc/callback";
const STATE_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_S = 120;
const TIMEOUT_MS = 10_000;

export class OidcError extends Error {}

// A silent (prompt=none) sign-in the provider could not complete without
// showing the user something; the caller starts an interactive one.
export class OidcInteractionRequired extends OidcError {
  readonly returnTo: string;
  constructor(returnTo: string) {
    super("The provider needs you to sign in again.");
    this.returnTo = returnTo;
  }
}

// OIDC Core 3.1.2.6: the errors that mean "ask again with a prompt", as
// opposed to a refusal.
const INTERACTION_ERRORS = new Set([
  "login_required",
  "interaction_required",
  "consent_required",
  "account_selection_required",
]);

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  usernameClaim: string;
  groupsClaim: string;
  redirectUri: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
}

export const OIDC_SECRET = { scope: "auth", id: "oidc" } as const;

async function clientSecret(core: Core): Promise<string> {
  try {
    return (await core.secrets.get(OIDC_SECRET.scope, OIDC_SECRET.id)) ?? "";
  } catch (err) {
    if (err instanceof SecretKeyError) throw new OidcError(err.message);
    throw err;
  }
}

export async function oidcConfig(core: Core): Promise<OidcConfig | null> {
  const s = core.settings;
  const issuer = s.string("auth.oidc.issuer");
  const clientId = s.string("auth.oidc.clientId");
  const origin = publicOrigin();
  if (!s.bool("auth.oidc.enabled") || !issuer || !clientId || !origin) return null;
  const secret = await clientSecret(core);
  if (!secret) return null;
  return {
    issuer,
    clientId,
    clientSecret: secret,
    scopes: s.string("auth.oidc.scopes"),
    usernameClaim: s.string("auth.oidc.usernameClaim") || "preferred_username",
    groupsClaim: s.string("auth.oidc.groupsClaim") || "groups",
    redirectUri: `${origin}${CALLBACK_PATH}`,
  };
}

// Why sign-in through OIDC is not available, for the admin page; null
// when it is.
export async function oidcUnavailableReason(core: Core): Promise<string | null> {
  const s = core.settings;
  if (!s.bool("auth.oidc.enabled")) return "OIDC sign-in is turned off.";
  if (!publicOrigin()) return "PUBLIC_ORIGIN is not set, so there is no redirect URI to give the provider.";
  if (!s.string("auth.oidc.issuer")) return "No issuer URL is set.";
  if (!s.string("auth.oidc.clientId")) return "No client ID is set.";
  if (!(await core.secrets.has(OIDC_SECRET.scope, OIDC_SECRET.id))) return "No client secret is set.";
  try {
    await clientSecret(core);
  } catch (err) {
    return (err as Error).message;
  }
  return null;
}

// Plain http is allowed only for a provider on this machine, which is how
// people test against a local Keycloak; anywhere else it would send the
// client secret and the code in the clear.
function assertSecureUrl(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OidcError(`The provider's ${what} is not a URL.`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new OidcError(`The provider's ${what} must use https.`);
  }
  return url;
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new OidcError(`Could not reach ${new URL(url).host}: ${(err as Error).message}`);
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new OidcError(`${new URL(url).host} answered ${response.status} with something that is not JSON.`);
  }
  if (!response.ok) {
    const detail = (body as { error_description?: unknown; error?: unknown }) ?? {};
    const reason = typeof detail.error_description === "string" ? detail.error_description : String(detail.error ?? "");
    throw new OidcError(`${new URL(url).host} answered ${response.status}${reason ? `: ${reason}` : ""}`);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body))
    throw new OidcError("Unexpected response from the provider.");
  return body as Record<string, unknown>;
}

const discoveryCache = new Map<string, { at: number; value: Discovery }>();

export async function discover(issuer: string): Promise<Discovery> {
  const cached = discoveryCache.get(issuer);
  if (cached !== undefined && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.value;
  assertSecureUrl(issuer, "issuer URL");
  const body = await fetchJson(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
  const value = body as unknown as Discovery;
  for (const field of ["issuer", "authorization_endpoint", "token_endpoint"] as const) {
    if (typeof value[field] !== "string") throw new OidcError(`The provider's discovery document has no ${field}.`);
  }
  // A document claiming to be some other issuer is either a misconfigured
  // URL or a substitution; either way its tokens would fail the iss check,
  // so refusing here gives the admin the reason instead.
  if (value.issuer.replace(/\/+$/, "") !== issuer.replace(/\/+$/, "")) {
    throw new OidcError(`The provider says its issuer is ${value.issuer}, not ${issuer}.`);
  }
  assertSecureUrl(value.authorization_endpoint, "authorization endpoint");
  assertSecureUrl(value.token_endpoint, "token endpoint");
  if (value.userinfo_endpoint) assertSecureUrl(value.userinfo_endpoint, "userinfo endpoint");
  discoveryCache.set(issuer, { at: Date.now(), value });
  return value;
}

function random(): string {
  return crypto.randomBytes(32).toString("base64url");
}

// Only a path on this console is accepted as somewhere to land after
// sign-in. Anything with a scheme or a host — including the
// protocol-relative "//evil.example" — would make the sign-in page an
// open redirect.
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  return raw;
}

export interface StartedSignIn {
  url: string;
}

// `link` names the signed-in user whose account the identity will be
// attached to; absent means an ordinary sign-in. Stored with the state so
// the callback cannot be talked into linking to anyone else. `silent`
// asks the provider not to show anything (a re-check of a live session);
// it is stored too, so the callback knows an interaction error means
// "retry interactively" rather than "refused".
export async function startSignIn(
  core: Core,
  returnTo: string,
  link: number | null = null,
  options: { silent?: boolean } = {}
): Promise<StartedSignIn> {
  const cfg = await oidcConfig(core);
  if (cfg === null) throw new OidcError((await oidcUnavailableReason(core)) ?? "OIDC sign-in is not configured.");
  const meta = await discover(cfg.issuer);
  const state = random();
  const nonce = random();
  const verifier = random();
  const now = Date.now();
  core.db.prepare("DELETE FROM oidc_states WHERE created_at < ?").run(now - STATE_TTL_MS);
  core.db
    .prepare(
      "INSERT INTO oidc_states (state, org_id, nonce, verifier, return_to, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(
      state,
      core.orgId,
      nonce,
      verifier,
      JSON.stringify({ returnTo: safeReturnTo(returnTo), link, silent: options.silent === true }),
      now
    );

  const scopes = new Set(cfg.scopes.split(/\s+/).filter(Boolean));
  scopes.add("openid");
  const url = new URL(meta.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: cfg.redirectUri,
    scope: [...scopes].join(" "),
    state,
    nonce,
    code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    ...(options.silent ? { prompt: "none" } : {}),
  }).toString();
  return { url: url.toString() };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new OidcError("The provider's ID token is malformed.");
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new OidcError("The provider's ID token is malformed.");
  }
}

export function checkIdTokenClaims(
  claims: Record<string, unknown>,
  expected: { issuer: string; clientId: string; nonce: string },
  nowMs = Date.now()
): void {
  const now = Math.floor(nowMs / 1000);
  if (String(claims.iss ?? "").replace(/\/+$/, "") !== expected.issuer.replace(/\/+$/, ""))
    throw new OidcError("ID token issuer mismatch.");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.clientId)) throw new OidcError("ID token was issued to a different client.");
  if (audiences.length > 1 && claims.azp !== expected.clientId)
    throw new OidcError("ID token was issued to a different client.");
  if (claims.nonce !== expected.nonce) throw new OidcError("ID token nonce mismatch.");
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < now) throw new OidcError("ID token has expired.");
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_S > now)
    throw new OidcError("ID token was issued in the future.");
  if (typeof claims.sub !== "string" || !claims.sub) throw new OidcError("ID token has no subject.");
}

export interface OidcProfile {
  provider: string;
  subject: string;
  username: string;
  email: string;
  emailVerified: boolean;
  name: string;
  groups: string[];
}

function claimList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (typeof value === "string") return value.split(/[,\s]+/).filter(Boolean);
  return [];
}

export interface FinishedSignIn {
  profile: OidcProfile;
  returnTo: string;
  link: number | null;
}

export async function finishSignIn(core: Core, query: Record<string, unknown>): Promise<FinishedSignIn> {
  if (typeof query.error === "string") {
    if (typeof query.state === "string" && INTERACTION_ERRORS.has(query.error)) {
      const row = core.db
        .prepare("DELETE FROM oidc_states WHERE state = ? RETURNING return_to, created_at")
        .get(query.state) as { return_to: string; created_at: number } | undefined;
      if (row !== undefined && Date.now() - row.created_at <= STATE_TTL_MS) {
        let stored: { returnTo?: unknown; silent?: unknown } = {};
        try {
          stored = JSON.parse(row.return_to) as typeof stored;
        } catch {
          // Unreadable: treated as an interactive sign-in that was refused.
        }
        if (stored.silent === true) throw new OidcInteractionRequired(safeReturnTo(stored.returnTo));
      }
    }
    const description = typeof query.error_description === "string" ? `: ${query.error_description}` : "";
    throw new OidcError(`The provider refused the sign-in (${query.error}${description}).`);
  }
  const state = typeof query.state === "string" ? query.state : "";
  const code = typeof query.code === "string" ? query.code : "";
  if (!state || !code) throw new OidcError("The sign-in response is missing its code or state.");

  // Consumed whether or not the rest succeeds, so a state can be used once.
  const row = core.db.prepare("DELETE FROM oidc_states WHERE state = ? RETURNING *").get(state) as
    { nonce: string; verifier: string; return_to: string; created_at: number } | undefined;
  if (row === undefined || Date.now() - row.created_at > STATE_TTL_MS) {
    throw new OidcError("This sign-in link has expired or was already used. Start again.");
  }
  let stored: { returnTo?: unknown; link?: unknown } = {};
  try {
    stored = JSON.parse(row.return_to) as typeof stored;
  } catch {
    // An unreadable record lands on the home page with no link.
  }

  const cfg = await oidcConfig(core);
  if (cfg === null) throw new OidcError((await oidcUnavailableReason(core)) ?? "OIDC sign-in is not configured.");
  const meta = await discover(cfg.issuer);

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: row.verifier,
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  // client_secret_basic is the spec's default and what a provider that
  // lists nothing supports; post is used only when basic is not offered.
  const methods = meta.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
  if (methods.includes("client_secret_basic")) {
    const user = encodeURIComponent(cfg.clientId);
    const pass = encodeURIComponent(cfg.clientSecret);
    headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  } else {
    form.set("client_id", cfg.clientId);
    form.set("client_secret", cfg.clientSecret);
  }
  const tokens = await fetchJson(meta.token_endpoint, { method: "POST", headers, body: form });
  if (typeof tokens.id_token !== "string") throw new OidcError("The provider returned no ID token.");

  const claims = decodeJwtPayload(tokens.id_token);
  checkIdTokenClaims(claims, { issuer: meta.issuer, clientId: cfg.clientId, nonce: row.nonce });

  // Many providers leave groups and some profile claims out of the ID
  // token; userinfo fills the gaps, and only for the same subject.
  let merged: Record<string, unknown> = { ...claims };
  if (meta.userinfo_endpoint && typeof tokens.access_token === "string") {
    try {
      const info = await fetchJson(meta.userinfo_endpoint, {
        headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json" },
      });
      if (info.sub === claims.sub) merged = { ...info, ...claims };
    } catch (err) {
      core.log.warn("OIDC userinfo lookup failed, continuing with the ID token alone", {
        error: (err as Error).message,
      });
    }
  }

  const email = typeof merged.email === "string" ? merged.email.trim().toLowerCase() : "";
  const username = String(merged[cfg.usernameClaim] ?? merged.preferred_username ?? email ?? "")
    .trim()
    .toLowerCase();
  return {
    profile: {
      provider: meta.issuer,
      subject: String(claims.sub),
      username,
      email,
      emailVerified: merged.email_verified !== false,
      name: typeof merged.name === "string" ? merged.name : "",
      groups: claimList(merged[cfg.groupsClaim]),
    },
    returnTo: safeReturnTo(stored.returnTo),
    link: typeof stored.link === "number" ? stored.link : null,
  };
}

export function groupAllowed(core: Core, groups: string[]): boolean {
  const allowed = core.settings.list("auth.oidc.allowedGroups").map((g) => g.toLowerCase());
  return allowed.length === 0 || groups.some((g) => allowed.includes(g.toLowerCase()));
}

export function groupIsAdmin(core: Core, groups: string[]): boolean {
  const admin = core.settings.list("auth.oidc.adminGroups").map((g) => g.toLowerCase());
  return admin.length > 0 && groups.some((g) => admin.includes(g.toLowerCase()));
}

// HTTP shapes for the platform's routes (S2), carried over from
// code-console's. Kept free of server-only imports so the client can use them.

import type { TokenArea } from "./grants.js";

export interface Me {
  id: string;
  name: string;
  email: string;
  groups: string[];
  admin: boolean;
  source: "password" | "oidc" | "dev-bypass" | "token";
  mustChangePassword: boolean;
  mustEnrollTotp?: boolean;
  orgId: string;
}

export interface AuthMethods {
  siteName: string;
  password: boolean;
  oidc: { label: string } | null;
  ip: string;
}

export type LoginResponse = { mustChangePassword: boolean } | { totpRequired: true; pending: string };

export interface AccountView {
  hasPassword: boolean;
  totpEnabled: boolean;
  totpAvailable: boolean;
  identities: Array<{ provider: string; email: string; createdAt: string; lastUsedAt: string | null }>;
  sessions: Array<{ id: string; method: string; ip: string; userAgent: string; lastSeenAt: string; current: boolean }>;
}

// Exactly one of the two: the current authenticator code, or one of the
// account's unused recovery codes for someone who has lost the authenticator.
// A recovery code is spent on use.
export type TotpVerifyRequest =
  { pending: string; code: string; recoveryCode?: never } | { pending: string; recoveryCode: string; code?: never };

export interface TotpStatus {
  enabled: boolean;
  available: boolean;
  required: boolean;
  recoveryCodesLeft: number;
}

export interface TotpEnrollment {
  secret: string;
  otpauthUrl: string;
}

export type Role = "admin" | "user";

export interface UserView {
  id: number;
  username: string;
  displayName: string;
  email: string;
  role: Role;
  disabled: boolean;
  mustChangePassword: boolean;
  hasPassword: boolean;
  totpEnabled: boolean;
  allowedNetworks: string[];
  createdAt: string;
  lastLoginAt: string | null;
  identities: Array<{ provider: string; subject: string; email: string; createdAt: string; lastUsedAt: string | null }>;
}

export interface NewUserRequest {
  username: string;
  displayName?: string;
  email?: string;
  role?: Role;
  // Omitted: a temporary password is generated and returned once.
  // null: no password (an account for OIDC sign-in only).
  password?: string | null;
}

export interface UserChangesRequest {
  displayName?: string;
  email?: string;
  role?: Role;
  disabled?: boolean;
  allowedNetworks?: string[];
}

export interface SessionView {
  id: string;
  method: string;
  ip: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
}

export type SettingType = "string" | "boolean" | "number" | "list" | "cidrs" | "url" | "enum" | "json";
export type SettingValue = string | boolean | number | string[] | Record<string, unknown>[];

export interface SettingView {
  key: string;
  group: string;
  label: string;
  help: string;
  type: SettingType;
  env?: string;
  default: SettingValue;
  options?: readonly string[];
  value: SettingValue;
  source: "ui" | "env" | "default";
  envValue?: string;
  envError?: string;
  // The environment's value overrides any saved one, so the field is shown
  // read-only while it is set.
  locked?: boolean;
}

// Where browsers reach this install. "request" means nothing is configured
// and the value is the address the current request arrived on.
export interface PublicUrlView {
  value: string;
  source: "env" | "ui" | "request";
}

export interface AdminOverview {
  settings: SettingView[];
  environment: Array<{ name: string; help: string; value: string; set: boolean }>;
  publicUrl: PublicUrlView;
  // hasKey: sign-in authenticates with a private key (SignInClientKey), set
  // by a connector; saving a client secret here replaces it.
  oidc: { redirectUri: string; hasSecret: boolean; hasKey?: boolean; unavailable: string | null };
  secretKeyConfigured: boolean;
  you: { ip: string };
  version: string;
}

export interface AuditRow {
  id: number;
  ts: number;
  username: string;
  ip: string;
  action: string;
  target: string;
  detail: string;
  result: "ok" | "denied" | "error";
}

// --- API tokens --------------------------------------------------------------
// A token acts as the admin who created it, capped by its scope: "read" may
// only read; "write" may do whatever that admin may. It is sent as
// `Authorization: Bearer <secret>` to /api and /mcp, never to /api/admin or
// /api/auth (managing accounts, sign-in and tokens takes a signed-in session).
// Its grant (./grants.ts) can narrow it further to some product areas and
// some namespaces; a token without one reaches everything its scope allows.
// The secret is shown once at creation and only its hash is stored.

export type ApiTokenScope = "read" | "write";

export interface ApiTokenView {
  id: string;
  name: string;
  scope: ApiTokenScope;
  // The grant's limits (ApiTokenGrant); absent: every namespace, every area.
  namespaces?: string[];
  areas?: TokenArea[];
  // The secret's first characters, to tell tokens apart; useless on its own.
  prefix: string;
  // The username the token acts as.
  createdBy: string;
  createdAt: string;
  // null: never expires.
  expiresAt: string | null;
  lastUsedAt: string | null;
  // Past expiresAt, or the account behind it is disabled or no longer an admin.
  inactive?: string;
  // "oauth": a grant an MCP client got through the OAuth flow (claude.ai's
  // connectors, say). Its access token is short-lived and refreshed by the
  // client; revoking the grant ends both. Absent: a token made on this page.
  kind?: "oauth";
  // oauth only: the name the client registered with.
  client?: string;
}

export interface NewApiTokenRequest {
  name: string;
  scope: ApiTokenScope;
  // Omitted or null: every namespace / every area. A list must not be empty.
  namespaces?: string[] | null;
  areas?: TokenArea[] | null;
  // Whole days from now, 1 to 3650; omitted or null: never expires.
  expiresInDays?: number | null;
}

// PATCH /api/admin/tokens/:id, OAuth grants included. Omitted: unchanged;
// null namespaces or areas: every one. Takes effect on the token's next request.
export interface ApiTokenChanges {
  name?: string;
  scope?: ApiTokenScope;
  namespaces?: string[] | null;
  areas?: TokenArea[] | null;
}

export interface NewApiToken {
  token: ApiTokenView;
  // Shown once; never retrievable again.
  secret: string;
}

// --- OAuth for MCP clients -------------------------------------------------
// The platform is an OAuth 2.1 authorization server for /mcp, as the MCP
// authorization spec describes, so a client that can't be given a token
// (claude.ai's custom connectors) can get one by having an admin sign in and
// approve it. Served outside /api, without a session unless noted:
//
//   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728 metadata
//   GET  /.well-known/oauth-authorization-server     RFC 8414 metadata
//   POST /oauth/register   RFC 7591 dynamic client registration (public
//                          clients only; https redirect URIs, or http on
//                          localhost); rate-limited
//   GET  /oauth/authorize  authorization code with PKCE S256 only; checks
//                          the client and redirect URI, then sends the
//                          browser to the console's #/oauth/consent page
//                          with the same query
//   POST /oauth/token      form-encoded; authorization_code (with
//                          code_verifier) and refresh_token grants; refresh
//                          tokens rotate on use
//
// A 401 from /mcp carries WWW-Authenticate: Bearer resource_metadata="...".
// Approving creates an ApiTokenView with kind "oauth", listed and revoked
// under Admin > API tokens like any other.

export const OAUTH_SCOPES: readonly ApiTokenScope[] = ["read", "write"];

// The /oauth/authorize query, passed on to the consent page unchanged.
export interface OAuthAuthorizeParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state?: string;
  // Space-separated; "write" asks for read and write.
  scope?: string;
  // RFC 8707 resource indicator; when given it must be this install's /mcp.
  resource?: string;
}

export interface OAuthConsentRequest {
  params: OAuthAuthorizeParams;
  // preview: check the request and describe it. approve: issue a code for
  // `scope` (default: what the client asked for) and say where to send the
  // browser. deny: say where to send the browser with access_denied.
  decision: "preview" | "approve" | "deny";
  scope?: ApiTokenScope;
  // approve: limits for the grant, as NewApiTokenRequest. Omitted: none.
  namespaces?: string[] | null;
  areas?: TokenArea[] | null;
}

export interface OAuthConsentView {
  client: { id: string; name: string; redirectUri: string };
  // What the client asked for, read when it named no scope.
  requestedScope: ApiTokenScope;
  // approve and deny: the client's redirect URI with code or error and state.
  redirect?: string;
}

// Wiring sign-in through an Authentik instance: an OAuth2/OpenID provider
// and an application made in Authentik through its API, and this install's
// OIDC settings and client secret filled in from them. Re-running finds the
// application by its slug and reuses it.

// What wiring would create, before any token is given.
export interface AuthentikWirePlan {
  // The Authentik base URL the plan was made for, as given (trailing slash
  // removed).
  authentikUrl: string;
  // Where the API is called, when not at authentikUrl.
  apiUrl?: string;
  applicationName: string;
  slug: string;
  // Registered on the provider; "" while there is no public URL.
  redirectUri: string;
  issuer: string;
  // An Authentik API token kept from an earlier run, so none need be pasted.
  hasStoredToken: boolean;
  // Why wiring can't run yet ("Set the public URL first.", "SECRETS_KEY is
  // not set ..."), or null.
  blocked: string | null;
}

export interface AuthentikWireRequest {
  // Authentik as browsers reach it: the issuer and launch URL are built on
  // it.
  authentikUrl: string;
  // Where this server calls Authentik's API, when not at authentikUrl:
  // typically its in-cluster Service (IngressHost.serviceUrl). Plain http is
  // accepted only for a cluster Service (*.svc, *.svc.cluster.local) or
  // localhost; anywhere else the token would cross the network in the
  // clear.
  apiUrl?: string;
  // An Authentik API token with rights to create providers and applications
  // (the bootstrap token or an admin's). Omitted: the stored one is used.
  // Never logged, never returned.
  token?: string;
  // Store the token sealed for later runs. False or omitted: it is used for
  // this request only, and a token stored earlier is deleted.
  keepToken?: boolean;
  // Saved as auth.oidc.adminGroups when given.
  adminGroups?: string[];
}

export interface AuthentikWireResult {
  authentikUrl: string;
  slug: string;
  issuer: string;
  clientId: string;
  redirectUri: string;
  application: "created" | "found";
  // "updated": an existing provider was missing the redirect URI and has
  // had it added.
  provider: "created" | "updated" | "unchanged";
  // Setting keys this run saved; the client secret is stored separately.
  settings: string[];
  tokenKept: boolean;
  // The issuer's discovery document as read back after wiring.
  discovery: { ok: boolean; error?: string };
  // Relative to the app's base URL: a browser navigation that signs in
  // through Authentik and links that identity to the current account.
  testSignIn: string;
}

// Sign-in through a provider anyone can hold an account with: a personal
// or work Google account, or any Microsoft account (personal or from any
// Entra tenant, through the "common" endpoint). Nobody is invited to a
// tenant; who gets in is decided here, by verified email.
export type PublicSignInProvider = "google" | "microsoft";

export interface PublicSignInRequest {
  provider: PublicSignInProvider;
  // The OAuth client made in Google Cloud Console, or the Entra app
  // registration set to "any organizational directory and personal
  // Microsoft accounts".
  clientId: string;
  // Omitted or "": the stored secret is kept, allowed only when the stored
  // client is already this provider with this client id.
  clientSecret?: string;
  // Saved as auth.oidc.allowedEmails. Each entry is an address
  // ("ann@example.com") or a domain ("@example.com" or "example.com").
  // Required and non-empty: with a public provider an empty list would let
  // every account in the world create one here.
  allowedEmails: string[];
  // Saved as auth.oidc.adminEmails: a verified sign-in with one of these
  // addresses makes the account an admin.
  adminEmails?: string[];
}

export interface PublicSignInResult {
  provider: PublicSignInProvider;
  issuer: string;
  clientId: string;
  redirectUri: string;
  // Setting keys this request saved; the client secret is stored separately.
  settings: string[];
  // The issuer's discovery document as read back after saving.
  discovery: { ok: boolean; error?: string };
}

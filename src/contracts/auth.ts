// HTTP shapes for the platform's routes (S2), carried over from
// code-console's. Kept free of server-only imports so the client can use them.

export interface Me {
  id: string;
  name: string;
  email: string;
  groups: string[];
  admin: boolean;
  source: "password" | "oidc" | "dev-bypass";
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
  oidc: { redirectUri: string; hasSecret: boolean; unavailable: string | null };
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

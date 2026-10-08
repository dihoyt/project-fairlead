// HTTP shapes for the platform's routes (S2), carried over from
// code-console's. Kept free of server-only imports so the client can use them.

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

// --- API tokens --------------------------------------------------------------
// A token acts as the admin who created it, capped by its scope: "read" may
// only read; "write" may do whatever that admin may. It is sent as
// `Authorization: Bearer <secret>` to /api and /mcp, never to /api/admin or
// /api/auth (managing accounts, sign-in and tokens takes a signed-in session).
// The secret is shown once at creation and only its hash is stored.

export type ApiTokenScope = "read" | "write";

export interface ApiTokenView {
  id: string;
  name: string;
  scope: ApiTokenScope;
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
}

export interface NewApiTokenRequest {
  name: string;
  scope: ApiTokenScope;
  // Whole days from now, 1 to 3650; omitted or null: never expires.
  expiresInDays?: number | null;
}

export interface NewApiToken {
  token: ApiTokenView;
  // Shown once; never retrievable again.
  secret: string;
}

import type { Request, Express } from "express";
import type { Server } from "node:http";
import type { ZodType } from "zod";
import type { Database } from "better-sqlite3";
import type { ApiTokenGrant } from "./grants.js";
import type { Migration } from "./runtime.js";

// Everything in this file is implemented by the platform (S2, src/platform/).
// S1 ships placeholders behind the same interfaces so modules can be built
// and tested before S2 lands.

export type SignInMethod = "password" | "oidc";

export interface User {
  // The username: stable for the life of the account, so anything owned by
  // or recorded against a person keys off it.
  id: string;
  name: string;
  email: string;
  groups: string[];
  admin: boolean;
  source: SignInMethod | "dev-bypass" | "token";
  mustChangePassword: boolean;
  mustEnrollTotp?: boolean;
  orgId: string;
  // Set when the request carried an API token (source "token"): which one,
  // the scope that caps what can() allows, and the grant's areas and
  // namespaces that the runtime checks each route against (./grants.ts).
  token?: { id: string } & ApiTokenGrant;
}

// Tenancy A: "read" is any signed-in user; "write" and "admin" are admins.
// S2 may refine "write" with roles; the three names are the contract. A
// "read"-scoped API token allows only "read", whoever created it.
export type Action = "read" | "write" | "admin";

export interface SettingSpec<T> {
  // "<moduleId>.<name>"; the context refuses a key outside the module's prefix.
  key: string;
  label: string;
  help?: string;
  schema: ZodType<T>;
  default: T;
  // Environment variable that overrides the default (the UI override wins
  // over it unless envOnly). No product prefix.
  env?: string;
  // Bootstrap and security settings: env or default only, shown read-only.
  envOnly?: boolean;
}

export interface Setting<T> {
  key: string;
  // Read fresh on every call; never cache across requests.
  get(): T;
  source(): "ui" | "env" | "default";
}

export interface SettingsRegistry {
  declare<T>(spec: SettingSpec<T>): Setting<T>;
}

export interface SecretStore {
  // scope is the module id, or "<moduleId>:<sub>"; the context refuses any
  // other scope. Values are encrypted at rest with SECRETS_KEY.
  get(scope: string, id: string): Promise<string | null>;
  has(scope: string, id: string): Promise<boolean>;
  put(scope: string, id: string, value: string): Promise<void>;
  delete(scope: string, id: string): Promise<void>;
}

// OIDC sign-in as a module sets it up: a connector that creates the app
// registration this install signs in through. Provided by the platform as
// ctx.services.get("signin"); the module never sees the settings or the
// secret store behind it.
export interface SignInOidcView {
  enabled: boolean;
  issuer: string;
  clientId: string;
  hasSecret: boolean;
  // A private key is stored: the token endpoint is called with a signed
  // client assertion (private_key_jwt) instead of the secret.
  hasKey: boolean;
  // <public URL>/auth/oidc/callback; "" until site.publicUrl or PUBLIC_ORIGIN is set.
  redirectUri: string;
  // Why setOidcClient() would refuse now, one sentence; null when it would not.
  blocked: string | null;
}

// A key pair registered with the provider for private_key_jwt client
// authentication (RFC 7523): the console signs a short-lived assertion with
// the private key at every code redemption, so no shared secret exists.
export interface SignInClientKey {
  // PKCS#8 PEM, RSA. Sealed like the client secret; never read back.
  privateKey: string;
  // The X.509 certificate (PEM) registered with the provider. Its SHA-1 and
  // SHA-256 thumbprints go in the assertion's x5t and x5t#S256 headers,
  // which is how Entra ID finds the key.
  certificate?: string;
  // The assertion's kid header, for providers that look keys up by id.
  keyId?: string;
}

export interface SignInOidcClient {
  issuer: string;
  clientId: string;
  // Exactly one of clientSecret and clientKey. Storing one removes the other.
  clientSecret?: string;
  clientKey?: SignInClientKey;
  // Left out: unchanged.
  label?: string;
  adminGroups?: string[];
  enabled?: boolean;
}

export interface SignInService {
  oidc(): Promise<SignInOidcView>;
  // The same writes as POST /api/admin/oidc/authentik: the client secret (or
  // key) and the auth.oidc.* settings given, audited as "auth.oidc.wire" with `actor`
  // (the username, or the module id for scheduled work). Throws with the
  // reason, writing nothing, when no public URL is set, SECRETS_KEY is
  // unset, one of the settings is locked by the environment, or the client
  // carries neither or both of clientSecret and clientKey.
  setOidcClient(client: SignInOidcClient, actor: string): Promise<void>;
  // The install seed (./onboarding.ts) only. Gives the built-in "admin"
  // account this password with no change asked at the next sign-in, while
  // that account has never signed in; audited "auth.seed-password" with
  // `actor`. Resolves false, changing nothing, once it has signed in or when
  // there is no such account. Throws with the reason on a password the
  // password policy refuses.
  seedAdminPassword(password: string, actor: string): Promise<boolean>;
  // Saves site.publicUrl as the admin settings page would, audited
  // "admin.setting-change" with `actor`. Throws with the reason when PUBLIC_ORIGIN
  // locks it or the value is not an http(s) URL.
  setPublicUrl(url: string, actor: string): Promise<void>;
}

// The sign-in gate in front of deployed apps (deploy.ts, "Sign-in gate").
// Traefik's forwardAuth calls GATE_FORWARD_PATH on the console's Service for
// every request to a gated app, with these query parameters:
// - proto: "https" or "http", the scheme people use for the app's address,
//   which behind a tunnel differs from what reaches Traefik. Default: the
//   forwarded scheme.
// - credentials: "1" lets a request carrying an Authorization header through
//   to the app (CatalogEntry.gate "credentials").
// The console answers 200 for a person signed in to it, sends a browser to
// sign in at the console's public URL and back, and answers anything else 401.
// Each app's host gets its own cookie through that round trip, tied to the
// console session: signing out of the console signs out of every app.
export const GATE_FORWARD_PATH = "/auth/forward";
// Headers a 200 carries for the app: the username and email of the person
// let through (the middleware's authResponseHeaders).
export const GATE_USER_HEADER = "Remote-User";
export const GATE_EMAIL_HEADER = "Remote-Email";

export interface GateReadiness {
  // A browser can be sent to sign in: a public URL is set.
  ready: boolean;
  // Why not, one sentence.
  reason?: string;
  // The console's public URL; "" until site.publicUrl or PUBLIC_ORIGIN is set.
  signInUrl: string;
}

export interface GateService {
  readiness(): GateReadiness;
  // Hosts the gate may send a signed-in person back to, so the sign-in
  // round trip can't be pointed at any other site. Checks from every caller
  // are ORed; with none, no host is allowed.
  allowHosts(check: (host: string) => boolean | Promise<boolean>): void;
}

export type AuditResult = "ok" | "denied" | "error";

export interface AuditEntry {
  // Username, or "system" for scheduled work.
  actor: string;
  // "<moduleId>.<verb>": "hosts.create", "backups.mark-restore-tested".
  action: string;
  target?: string;
  detail?: string;
  ip?: string;
  result?: AuditResult;
}

export interface AuditLog {
  // Never throws: a failed audit write must not turn a completed action
  // into an error the caller sees.
  record(entry: AuditEntry): void;
}

export interface Platform {
  // Its own tables, applied as module "platform" before any module's.
  migrations: readonly Migration[];
  // Mounted first, ahead of the body parser: the drain guard.
  early(app: Express): void;
  // Mounted after the body parser and before module routers: session lookup,
  // origin guard, /api/auth, /api/admin, /api/me, /auth/oidc/*. Every /api
  // request that reaches a module router after this has an identity.
  install(app: Express): void;
  identify(req: Request): User | null;
  can(user: User, action: Action): boolean;
  // A single-use ticket, valid for a few seconds, that makes one internal
  // request (ModuleContext.call) carry this request's identity without
  // resolving it again. Throws on a request with no identity. Only this
  // process can mint one, so a ticket from outside never matches.
  vouch(req: Request): string;
  settings: SettingsRegistry;
  secrets: SecretStore;
  audit: AuditLog;
  // Provided to modules as services "signin".
  signIn: SignInService;
  // Provided to modules as services "gate".
  gate: GateService;
  // Removes UI overrides from the settings table so each falls back to its
  // environment value or default. Considers the keys in `only` (every
  // override when absent), then drops any key in `except` or starting with
  // one of `exceptPrefixes`. Returns the rows removed. Same-connection
  // statements, so it joins an open transaction.
  clearSettings(options: {
    only?: readonly string[];
    except?: readonly string[];
    exceptPrefixes?: readonly string[];
  }): number;
  // Gives the built-in "admin" account a new random password, marks it to be
  // changed at the next sign-in. Returns the password once. Throws if no such account exists.
  resetAdminPassword(): Promise<string>;
  // True once a drain has begun; /healthz answers 503 while it is.
  draining(): boolean;
  // Wires SIGTERM/SIGINT: drain, then stop() (scheduler, DB), then exit.
  handleSignals(server: Server, stop: () => Promise<void>): void;
}

export interface PlatformDeps {
  db: Database;
  dataDir: string;
  orgId: string;
  // Tests only: replaces session lookup so a test can put an identity on a
  // request without signing in. The server entrypoint never passes it.
  identify?: (req: Request) => User | null;
}

// The header an internal request carries its vouch() ticket in.
export const INTERNAL_CALL_HEADER = "x-internal-call";

export type CreatePlatform = (deps: PlatformDeps) => Platform;

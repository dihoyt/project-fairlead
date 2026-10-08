import type { Request, Express } from "express";
import type { Server } from "node:http";
import type { ZodType } from "zod";
import type { Database } from "better-sqlite3";
import type { ApiTokenScope } from "./auth.js";
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
  // and the scope that caps what can() allows.
  token?: { id: string; scope: ApiTokenScope };
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

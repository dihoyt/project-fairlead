import type { Migration } from "../contracts/runtime.js";
import { DEFAULT_ORG_ID } from "../runtime/migrations.js";

// The platform's own state: who may sign in, their sessions, what an admin
// changed in the UI, encrypted secrets, and the audit trail. Table names are
// code-console's. Append only and additive: during a rollout the old pod
// keeps running its queries against the new schema until it exits.
const org = `org_id TEXT NOT NULL DEFAULT '${DEFAULT_ORG_ID}' REFERENCES orgs(id)`;

export const platformMigrations: readonly Migration[] = [
  {
    version: 1,
    name: "auth, settings, secrets, audit",
    up: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ${org},
        -- The stable key anything owned by a person hangs off, so it never
        -- changes once created. Compared case-insensitively at sign-in.
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        -- NULL for an account that can only sign in through OIDC.
        password_hash TEXT,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        disabled INTEGER NOT NULL DEFAULT 0,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        -- JSON array of CIDRs. Empty means this user has no rule of their own.
        allowed_networks TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        last_login_at INTEGER,
        -- Sealed with SECRETS_KEY; recovery codes are a JSON array of hashes.
        totp_secret TEXT,
        totp_enabled_at INTEGER,
        recovery_codes TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE identities (
        -- The issuer URL, so two providers can never collide on a subject.
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        ${org},
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        PRIMARY KEY (provider, subject)
      );

      CREATE TABLE sessions (
        -- SHA-256 of the cookie value. The cookie itself is never stored, so
        -- a copy of this file signs nobody in.
        id_hash TEXT PRIMARY KEY,
        ${org},
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        method TEXT NOT NULL CHECK (method IN ('password', 'oidc')),
        -- Groups as the provider stated them at sign-in, so admin groups
        -- apply for the life of the session without asking again.
        groups TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ip TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT '',
        -- When an OIDC session last went back through the provider.
        oidc_checked_at INTEGER
      );
      CREATE INDEX sessions_user ON sessions(user_id);

      -- One row per OIDC sign-in in progress, between the redirect out and
      -- the callback. In the database rather than a cookie so the callback
      -- can land on either pod during a rollout.
      CREATE TABLE oidc_states (
        state TEXT PRIMARY KEY,
        ${org},
        nonce TEXT NOT NULL,
        verifier TEXT NOT NULL,
        return_to TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );

      -- UI overrides of the settings registry. A row present means "set in
      -- the UI"; deleting it falls back to the environment's value.
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        ${org},
        value TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE secrets (
        scope TEXT NOT NULL,
        id TEXT NOT NULL,
        ${org},
        ciphertext TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, id)
      );

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ${org},
        ts INTEGER NOT NULL,
        -- Denormalised so the log still reads after the user is deleted.
        username TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL CHECK (result IN ('ok', 'denied', 'error'))
      );
      CREATE INDEX audit_ts ON audit_log(ts);
    `,
  },
  {
    version: 2,
    name: "api tokens",
    up: `
      -- A token acts as the account that created it, capped by its scope.
      -- Only the SHA-256 of the secret is kept, as for sessions.
      CREATE TABLE api_tokens (
        id TEXT PRIMARY KEY,
        ${org},
        secret_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        name TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        last_used_at INTEGER
      );
    `,
  },
  {
    version: 3,
    name: "oauth for mcp clients",
    up: `
      -- Clients that registered themselves (RFC 7591). Public clients only:
      -- there is no client secret, PKCE is what binds a code to its client.
      CREATE TABLE oauth_clients (
        client_id TEXT PRIMARY KEY,
        ${org},
        name TEXT NOT NULL,
        redirect_uris TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- Authorization codes, single use and short-lived; only their hash.
      CREATE TABLE oauth_codes (
        code_hash TEXT PRIMARY KEY,
        ${org},
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      -- A grant is an api_tokens row whose secret is the current access
      -- token, replaced (with the refresh token) on every refresh.
      ALTER TABLE api_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'token';
      ALTER TABLE api_tokens ADD COLUMN client_id TEXT;
      ALTER TABLE api_tokens ADD COLUMN refresh_hash TEXT;
      ALTER TABLE api_tokens ADD COLUMN access_expires_at INTEGER;
      CREATE UNIQUE INDEX api_tokens_refresh ON api_tokens(refresh_hash);
    `,
  },
  {
    version: 4,
    name: "app sign-in gate",
    up: `
      -- The sign-in gate's round trip: a ticket the console hands a signed-in
      -- browser for one app host, single use and short-lived, exchanged on
      -- that host for a grant whose cookie the host keeps. Both hold only
      -- hashes and die with the console session they came from.
      CREATE TABLE gate_tickets (
        ticket_hash TEXT PRIMARY KEY,
        ${org},
        session_hash TEXT NOT NULL REFERENCES sessions(id_hash) ON DELETE CASCADE,
        host TEXT NOT NULL,
        return_path TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE gate_grants (
        grant_hash TEXT PRIMARY KEY,
        ${org},
        session_hash TEXT NOT NULL REFERENCES sessions(id_hash) ON DELETE CASCADE,
        host TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX gate_grants_session ON gate_grants(session_hash);
    `,
  },
  {
    version: 5,
    name: "api token grants",
    up: `
      -- A token's areas and namespaces as JSON arrays; NULL is every one, so
      -- tokens made before grants keep reaching everything.
      ALTER TABLE api_tokens ADD COLUMN namespaces TEXT;
      ALTER TABLE api_tokens ADD COLUMN areas TEXT;
      -- The same limits chosen on the consent page, carried to the grant.
      ALTER TABLE oauth_codes ADD COLUMN namespaces TEXT;
      ALTER TABLE oauth_codes ADD COLUMN areas TEXT;
    `,
  },
];

import type { Migration } from "../../contracts/runtime.js";

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "channels, pending changes and sent state",
    up: `
      CREATE TABLE notify_channels (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id),
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        min_severity TEXT NOT NULL DEFAULT 'warn',
        config TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_sent_at TEXT,
        last_error TEXT
      );

      -- One row per check with a change not yet delivered. Survives a restart
      -- and is visible to both pods during a rollout.
      CREATE TABLE notify_pending (
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id),
        provider_id TEXT NOT NULL,
        check_id TEXT NOT NULL,
        label TEXT NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        detail TEXT NOT NULL,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        rev INTEGER NOT NULL DEFAULT 1,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (org_id, provider_id, check_id)
      );

      -- The last status each channel was told about, per check.
      CREATE TABLE notify_sent (
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id),
        channel_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        check_id TEXT NOT NULL,
        status TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (org_id, channel_id, provider_id, check_id)
      );
    `,
  },
  {
    version: 2,
    name: "email sign-in states",
    up: `
      -- One row per "sign in to send" in flight; single use, 10 minutes.
      CREATE TABLE notify_oauth_states (
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id),
        state TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        verifier TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (org_id, state)
      );
    `,
  },
];

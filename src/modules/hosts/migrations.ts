import type { Migration } from "../../contracts/runtime.js";

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "host inventory and last collection",
    up: `
      CREATE TABLE hosts_inventory (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id),
        label TEXT NOT NULL,
        address TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22,
        username TEXT NOT NULL,
        auth TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'auto',
        backup_target_paths TEXT NOT NULL DEFAULT '[]',
        host_key_fingerprint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        -- Written by whichever pod collected last, so a restart or the other
        -- pod in a rollout shows the same state.
        status TEXT NOT NULL DEFAULT 'unknown',
        detected_kind TEXT,
        facts TEXT NOT NULL DEFAULT '{}',
        filesystems TEXT NOT NULL DEFAULT '[]',
        results TEXT NOT NULL DEFAULT '[]',
        last_collected_at TEXT,
        last_seen_at TEXT,
        last_error TEXT
      );
    `,
  },
];

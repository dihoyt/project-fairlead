import type { Migration } from "../../contracts/runtime.js";

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "connector instances and the objects they created",
    up: `
      CREATE TABLE connectors_instances (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id),
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        -- Non-secret field values; secret ones are in the secret store.
        config TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'unknown',
        checks TEXT NOT NULL DEFAULT '[]',
        checked_at TEXT,
        drift TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE connectors_owned (
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id),
        instance_id TEXT NOT NULL,
        key TEXT NOT NULL,
        kind TEXT NOT NULL,
        external_id TEXT,
        spec TEXT NOT NULL DEFAULT '{}',
        spec_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (instance_id, key, kind)
      );
    `,
  },
];

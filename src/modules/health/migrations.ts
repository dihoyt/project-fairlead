import type { Migration } from "../../contracts/runtime.js";

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "check results, history, provider runs, lease",
    up: `
      CREATE TABLE health_check_results (
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id),
        provider_id TEXT NOT NULL,
        check_id TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        value TEXT,
        detail TEXT NOT NULL,
        raw TEXT,
        deep_link TEXT,
        observed_at TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        PRIMARY KEY (org_id, provider_id, check_id)
      );

      CREATE TABLE health_check_history (
        id INTEGER PRIMARY KEY,
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id),
        provider_id TEXT NOT NULL,
        check_id TEXT NOT NULL,
        at TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE INDEX health_check_history_lookup ON health_check_history (org_id, provider_id, check_id, at);
      CREATE INDEX health_check_history_at ON health_check_history (at);

      CREATE TABLE health_provider_runs (
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id),
        provider_id TEXT NOT NULL,
        last_run_at TEXT NOT NULL,
        last_error TEXT,
        run_by TEXT NOT NULL,
        PRIMARY KEY (org_id, provider_id)
      );

      CREATE TABLE health_leases (
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id),
        name TEXT NOT NULL,
        holder TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (org_id, name)
      );
    `,
  },
  {
    version: 2,
    name: "check result object",
    up: "ALTER TABLE health_check_results ADD COLUMN object TEXT",
  },
  {
    version: 3,
    name: "custom links",
    up: `
      CREATE TABLE health_links (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id),
        category TEXT NOT NULL,
        label TEXT NOT NULL,
        url TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
];

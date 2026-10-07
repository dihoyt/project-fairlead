import type { Migration } from "../../contracts/runtime.js";

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "check definitions and last result",
    up: `
      CREATE TABLE checks_targets (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id),
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        target TEXT NOT NULL,
        interval_ms INTEGER NOT NULL,
        timeout_ms INTEGER NOT NULL,
        -- JSON array of status codes; NULL means any 2xx or 3xx.
        expect_status TEXT,
        tls_warn_days INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        -- JSON CheckResult of the last probe, and when it ran (unix ms).
        last_result TEXT,
        last_run_at INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "body match, auth header and insecureSkipVerify",
    up: `
      ALTER TABLE checks_targets ADD COLUMN body_match TEXT;
      ALTER TABLE checks_targets ADD COLUMN auth_header TEXT;
      ALTER TABLE checks_targets ADD COLUMN insecure_skip_verify INTEGER NOT NULL DEFAULT 0;
    `,
  },
];

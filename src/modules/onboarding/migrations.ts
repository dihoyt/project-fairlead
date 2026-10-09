import type { Migration } from "../../contracts/runtime.js";

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "first-run step states",
    up: `
      CREATE TABLE onboarding_steps (
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id),
        step TEXT NOT NULL,
        -- "done" or "skipped"; a step with no row is still to do.
        state TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (org_id, step)
      );
    `,
  },
  {
    version: 2,
    name: "install seed summary",
    up: `
      CREATE TABLE onboarding_seed (
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id) PRIMARY KEY,
        imported_at TEXT NOT NULL,
        applied_at TEXT,
        applied_by TEXT,
        -- Epoch ms while a pod runs /apply; cleared when it finishes.
        applying_since INTEGER,
        dismissed INTEGER NOT NULL DEFAULT 0,
        -- JSON SeedItemResult[], never a value from the file.
        items TEXT NOT NULL
      );
    `,
  },
];

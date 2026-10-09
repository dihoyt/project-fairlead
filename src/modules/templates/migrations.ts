import type { Migration } from "../../contracts/runtime.js";

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "template instances",
    up: `
      CREATE TABLE templates_instances (
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id),
        name TEXT NOT NULL,
        template_id TEXT NOT NULL,
        -- The image tag (or digest) it was last installed with.
        version TEXT NOT NULL,
        -- "" for no Ingress.
        host TEXT NOT NULL DEFAULT '',
        volume_size TEXT,
        storage_class TEXT,
        -- CustomAppSpec as JSON, for the custom template.
        custom TEXT,
        last_job_id TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (org_id, name)
      );
    `,
  },
  {
    version: 2,
    name: "external services",
    up: `
      -- ExternalServiceSpec as JSON, for the external template.
      ALTER TABLE templates_instances ADD COLUMN external TEXT;
    `,
  },
];

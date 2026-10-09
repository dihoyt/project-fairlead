import type { Migration } from "../../contracts/runtime.js";

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "per-host choices and the last sync",
    up: `
      CREATE TABLE connector_cloudflare_hosts (
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id),
        host TEXT NOT NULL,
        -- NULL: follow the Access step's mode.
        exposure TEXT,
        -- NULL: not chosen (off under "per-app").
        access INTEGER,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (org_id, host)
      );

      CREATE TABLE connector_cloudflare_state (
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id) PRIMARY KEY,
        -- A tunnel created or adopted through POST /tunnel, when the
        -- connector's own Tunnel ID field is empty.
        tunnel_id TEXT,
        tunnel_created INTEGER NOT NULL DEFAULT 0,
        view TEXT,
        synced_at TEXT
      );
    `,
  },
];

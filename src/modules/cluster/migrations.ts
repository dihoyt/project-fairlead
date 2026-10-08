import type { Migration } from "../../contracts/runtime.js";

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "join links",
    // Only a SHA-256 of each token is kept: the link itself is shown once.
    up: `CREATE TABLE cluster_join_links (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id),
      token_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      revoked_at INTEGER
    )`,
  },
];

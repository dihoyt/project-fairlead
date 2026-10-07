import type { Migration } from "../../contracts/runtime.js";

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "manual restore-test marks",
    up: `
      CREATE TABLE backups_restore_tests (
        id INTEGER PRIMARY KEY,
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id),
        pvc_uid TEXT NOT NULL,
        -- Kept beside the uid so a mark stays readable after its PVC is gone.
        namespace TEXT NOT NULL,
        name TEXT NOT NULL,
        tested_at TEXT NOT NULL,
        note TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX backups_restore_tests_pvc ON backups_restore_tests (org_id, pvc_uid, tested_at);
    `,
  },
];

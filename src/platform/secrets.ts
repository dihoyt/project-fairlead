import type { Database } from "better-sqlite3";
import type { SecretStore } from "../contracts/platform.js";
import { open, seal } from "./secretBox.js";

// Sealed with SECRETS_KEY in the database. Without the key nothing can be
// stored or read back, and the error says so; `has` still answers, since a
// row's presence is not the secret.
export interface PlatformSecrets extends SecretStore {
  // Records who stored the value, for the platform's own admin routes.
  putAs(scope: string, id: string, value: string, by: string): Promise<void>;
}

export function createSecrets(db: Database, orgId: string): PlatformSecrets {
  const putAs = async (scope: string, id: string, value: string, by: string) => {
    db.prepare(
      `INSERT INTO secrets (scope, id, org_id, ciphertext, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, id) DO UPDATE SET ciphertext = excluded.ciphertext,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    ).run(scope, id, orgId, seal(value), by, Date.now());
  };
  return {
    async get(scope, id) {
      const row = db.prepare("SELECT ciphertext FROM secrets WHERE scope = ? AND id = ?").get(scope, id) as
        { ciphertext: string } | undefined;
      return row === undefined ? null : open(row.ciphertext);
    },
    async has(scope, id) {
      return db.prepare("SELECT 1 FROM secrets WHERE scope = ? AND id = ?").get(scope, id) !== undefined;
    },
    put: (scope, id, value) => putAs(scope, id, value, "system"),
    putAs,
    async delete(scope, id) {
      db.prepare("DELETE FROM secrets WHERE scope = ? AND id = ?").run(scope, id);
    },
  };
}

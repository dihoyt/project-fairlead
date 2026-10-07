import type { Database } from "better-sqlite3";
import type { PvcRef, RestoreTestMark } from "../../contracts/backups.js";

interface MarkRow {
  pvc_uid: string;
  tested_at: string;
  note: string;
  created_by: string;
}

export function createStore(db: Database, orgId: string) {
  return {
    insert(pvc: PvcRef, mark: RestoreTestMark, createdAt: string): void {
      db.prepare(
        `INSERT INTO backups_restore_tests (org_id, pvc_uid, namespace, name, tested_at, note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(orgId, pvc.uid, pvc.namespace, pvc.name, mark.at, mark.note, mark.by, createdAt);
    },

    // The most recent test per PVC, by the date the restore was tested
    // rather than when it was recorded.
    latest(): Map<string, RestoreTestMark> {
      const rows = db
        .prepare(
          `SELECT pvc_uid, tested_at, note, created_by FROM backups_restore_tests
           WHERE org_id = ? ORDER BY tested_at, id`
        )
        .all(orgId) as MarkRow[];
      const marks = new Map<string, RestoreTestMark>();
      for (const row of rows) marks.set(row.pvc_uid, { at: row.tested_at, note: row.note, by: row.created_by });
      return marks;
    },
  };
}

export type Store = ReturnType<typeof createStore>;

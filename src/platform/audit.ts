import type { Database } from "better-sqlite3";
import type { AuditRow } from "../contracts/auth.js";
import type { AuditLog } from "../contracts/platform.js";
import type { Logger } from "../contracts/runtime.js";

export interface PlatformAudit extends AuditLog {
  read(limit?: number, before?: number): AuditRow[];
}

export function createAudit(db: Database, orgId: string, log: Logger): PlatformAudit {
  return {
    // Never throws: an audit write failing must not turn a sign-in or a
    // settings change that already happened into an error the caller sees.
    record(entry) {
      try {
        db.prepare(
          "INSERT INTO audit_log (org_id, ts, username, ip, action, target, detail, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          orgId,
          Date.now(),
          entry.actor,
          entry.ip ?? "",
          entry.action,
          entry.target ?? "",
          entry.detail ?? "",
          entry.result ?? "ok"
        );
      } catch (err) {
        log.error("Audit write failed", { action: entry.action, error: (err as Error).message });
      }
    },
    read(limit = 200, before) {
      const capped = Math.min(Math.max(1, Math.floor(limit)), 1000);
      const columns = "id, ts, username, ip, action, target, detail, result";
      return (
        before === undefined
          ? db.prepare(`SELECT ${columns} FROM audit_log ORDER BY id DESC LIMIT ?`).all(capped)
          : db.prepare(`SELECT ${columns} FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?`).all(before, capped)
      ) as AuditRow[];
    },
  };
}

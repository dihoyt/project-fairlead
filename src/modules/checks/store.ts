import type { Database } from "better-sqlite3";
import type { CheckKind, CheckView } from "../../contracts/checks.js";
import type { CheckResult } from "../../contracts/health.js";

export interface CheckRow {
  id: string;
  label: string;
  kind: CheckKind;
  target: string;
  interval_ms: number;
  timeout_ms: number;
  expect_status: string | null;
  body_match: string | null;
  auth_header: string | null;
  insecure_skip_verify: number;
  tls_warn_days: number;
  enabled: number;
  last_result: string | null;
  last_run_at: number | null;
}

export type CheckFields = Omit<CheckView, "id" | "last" | "hasSecret">;

const COLUMNS =
  "id, label, kind, target, interval_ms, timeout_ms, expect_status, body_match, auth_header, insecure_skip_verify, " +
  "tls_warn_days, enabled, last_result, last_run_at";

export function toView(row: CheckRow, hasSecret: boolean): CheckView {
  const view: CheckView = {
    id: row.id,
    label: row.label,
    kind: row.kind,
    target: row.target,
    intervalMs: row.interval_ms,
    timeoutMs: row.timeout_ms,
    hasSecret,
    insecureSkipVerify: row.insecure_skip_verify === 1,
    tlsWarnDays: row.tls_warn_days,
    enabled: row.enabled === 1,
  };
  if (row.expect_status) view.expectStatus = JSON.parse(row.expect_status) as number[];
  if (row.body_match !== null) view.bodyMatch = row.body_match;
  if (row.auth_header !== null) view.authHeader = row.auth_header;
  if (row.last_result) view.last = JSON.parse(row.last_result) as CheckResult;
  return view;
}

export function createStore(db: Database, orgId: string) {
  return {
    list(): CheckRow[] {
      return db
        .prepare(`SELECT ${COLUMNS} FROM checks_targets WHERE org_id = ? ORDER BY label COLLATE NOCASE, id`)
        .all(orgId) as CheckRow[];
    },

    get(id: string): CheckRow | undefined {
      return db.prepare(`SELECT ${COLUMNS} FROM checks_targets WHERE org_id = ? AND id = ?`).get(orgId, id) as
        CheckRow | undefined;
    },

    insert(id: string, fields: CheckFields, at: string): void {
      db.prepare(
        `INSERT INTO checks_targets
           (id, org_id, label, kind, target, interval_ms, timeout_ms, expect_status, body_match, auth_header,
            insecure_skip_verify, tls_warn_days, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        orgId,
        fields.label,
        fields.kind,
        fields.target,
        fields.intervalMs,
        fields.timeoutMs,
        fields.expectStatus ? JSON.stringify(fields.expectStatus) : null,
        fields.bodyMatch ?? null,
        fields.authHeader ?? null,
        fields.insecureSkipVerify ? 1 : 0,
        fields.tlsWarnDays,
        fields.enabled ? 1 : 0,
        at,
        at
      );
    },

    // A changed kind or target makes the last result evidence about something
    // else, so it is dropped and the check runs again on the next pass.
    update(id: string, fields: CheckFields, at: string, resetResult: boolean): void {
      db.prepare(
        `UPDATE checks_targets
            SET label = ?, kind = ?, target = ?, interval_ms = ?, timeout_ms = ?, expect_status = ?,
                body_match = ?, auth_header = ?, insecure_skip_verify = ?, tls_warn_days = ?, enabled = ?, updated_at = ?,
                last_result = CASE WHEN ? THEN NULL ELSE last_result END,
                last_run_at = CASE WHEN ? THEN NULL ELSE last_run_at END
          WHERE org_id = ? AND id = ?`
      ).run(
        fields.label,
        fields.kind,
        fields.target,
        fields.intervalMs,
        fields.timeoutMs,
        fields.expectStatus ? JSON.stringify(fields.expectStatus) : null,
        fields.bodyMatch ?? null,
        fields.authHeader ?? null,
        fields.insecureSkipVerify ? 1 : 0,
        fields.tlsWarnDays,
        fields.enabled ? 1 : 0,
        at,
        resetResult ? 1 : 0,
        resetResult ? 1 : 0,
        orgId,
        id
      );
    },

    remove(id: string): boolean {
      return db.prepare("DELETE FROM checks_targets WHERE org_id = ? AND id = ?").run(orgId, id).changes > 0;
    },

    // Guarded on the target so a probe that finishes after an edit doesn't
    // write its result onto the new definition.
    recordResult(id: string, target: string, result: CheckResult, ranAt: number): void {
      db.prepare(
        "UPDATE checks_targets SET last_result = ?, last_run_at = ? WHERE org_id = ? AND id = ? AND target = ?"
      ).run(JSON.stringify(result), ranAt, orgId, id, target);
    },
  };
}

export type Store = ReturnType<typeof createStore>;

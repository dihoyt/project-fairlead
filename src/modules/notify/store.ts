import type { Database } from "better-sqlite3";
import type { ChannelKind, ChannelView } from "../../contracts/notify.js";

export interface ChannelRow {
  id: string;
  kind: ChannelKind;
  label: string;
  enabled: number;
  min_severity: "warn" | "crit";
  config: string;
  last_sent_at: string | null;
  last_error: string | null;
}

const COLUMNS = "id, kind, label, enabled, min_severity, config, last_sent_at, last_error";

export function parseConfig(raw: string): ChannelView["config"] {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const config: ChannelView["config"] = {};
    if (typeof parsed.server === "string") config.server = parsed.server;
    if (typeof parsed.topic === "string") config.topic = parsed.topic;
    return config;
  } catch {
    return {};
  }
}

export function listChannelRows(db: Database, orgId: string): ChannelRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM notify_channels WHERE org_id = ? ORDER BY created_at, id`)
    .all(orgId) as ChannelRow[];
}

export function getChannelRow(db: Database, orgId: string, id: string): ChannelRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM notify_channels WHERE org_id = ? AND id = ?`).get(orgId, id) as
    ChannelRow | undefined;
}

export function toView(row: ChannelRow, hasSecret: boolean): ChannelView {
  const view: ChannelView = {
    id: row.id,
    kind: row.kind,
    label: row.label,
    enabled: row.enabled === 1,
    minSeverity: row.min_severity,
    config: parseConfig(row.config),
    hasSecret,
  };
  if (row.last_sent_at) view.lastSentAt = row.last_sent_at;
  if (row.last_error) view.lastError = row.last_error;
  return view;
}

export function markResult(
  db: Database,
  orgId: string,
  id: string,
  result: { ok: boolean; error?: string },
  at: string
): void {
  if (result.ok) {
    db.prepare("UPDATE notify_channels SET last_sent_at = ?, last_error = NULL WHERE org_id = ? AND id = ?").run(
      at,
      orgId,
      id
    );
  } else {
    db.prepare("UPDATE notify_channels SET last_error = ? WHERE org_id = ? AND id = ?").run(
      result.error ?? "Delivery failed.",
      orgId,
      id
    );
  }
}

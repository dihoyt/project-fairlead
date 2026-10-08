import type { Database } from "better-sqlite3";
import type { CheckResult, Status } from "../../contracts/health.js";
import type { HostKind, HostView } from "../../contracts/hosts.js";
import type { DetectedKind, Facts } from "./collect.js";
import type { Filesystem } from "./parse.js";

export interface HostRow {
  id: string;
  label: string;
  address: string;
  port: number;
  username: string;
  auth: "key" | "password";
  kind: HostKind;
  backup_target_paths: string;
  host_key_fingerprint: string | null;
  generated_key: 0 | 1;
  created_at: string;
  updated_at: string;
  status: Status;
  detected_kind: DetectedKind | null;
  facts: string;
  filesystems: string;
  results: string;
  last_collected_at: string | null;
  last_seen_at: string | null;
  last_error: string | null;
}

export interface HostFields {
  label: string;
  address: string;
  port: number;
  username: string;
  auth: "key" | "password";
  kind: HostKind;
  backupTargetPaths: string[];
  hostKeyFingerprint: string | null;
  generatedKey: boolean;
}

export interface CollectionRecord {
  status: Status;
  results: CheckResult[];
  at: string;
  // Present when the host was reached.
  seen?: { detectedKind: DetectedKind; facts: Facts; filesystems: Filesystem[]; fingerprint: string };
  error?: string;
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function createStore(db: Database, orgId: string) {
  return {
    list(): HostRow[] {
      return db.prepare("SELECT * FROM hosts_inventory WHERE org_id = ? ORDER BY label, id").all(orgId) as HostRow[];
    },

    get(id: string): HostRow | undefined {
      return db.prepare("SELECT * FROM hosts_inventory WHERE org_id = ? AND id = ?").get(orgId, id) as
        HostRow | undefined;
    },

    insert(id: string, fields: HostFields, at: string): void {
      db.prepare(
        `INSERT INTO hosts_inventory
           (id, org_id, label, address, port, username, auth, kind, backup_target_paths, host_key_fingerprint,
            generated_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        orgId,
        fields.label,
        fields.address,
        fields.port,
        fields.username,
        fields.auth,
        fields.kind,
        JSON.stringify(fields.backupTargetPaths),
        fields.hostKeyFingerprint,
        fields.generatedKey ? 1 : 0,
        at,
        at
      );
    },

    // A change of where or as whom to connect makes the last collection
    // evidence about a different thing, so it is cleared.
    update(id: string, fields: HostFields, at: string, resetState: boolean): void {
      db.prepare(
        `UPDATE hosts_inventory SET label = ?, address = ?, port = ?, username = ?, auth = ?, kind = ?,
           backup_target_paths = ?, host_key_fingerprint = ?, generated_key = ?, updated_at = ?
           ${resetState ? ", status = 'unknown', results = '[]', last_error = NULL, last_collected_at = NULL" : ""}
         WHERE org_id = ? AND id = ?`
      ).run(
        fields.label,
        fields.address,
        fields.port,
        fields.username,
        fields.auth,
        fields.kind,
        JSON.stringify(fields.backupTargetPaths),
        fields.hostKeyFingerprint,
        fields.generatedKey ? 1 : 0,
        at,
        orgId,
        id
      );
    },

    remove(id: string): boolean {
      return db.prepare("DELETE FROM hosts_inventory WHERE org_id = ? AND id = ?").run(orgId, id).changes > 0;
    },

    // Trust on first use: the fingerprint is only written while none is
    // pinned, and only if the host still points where it was collected from.
    pinIfUnset(row: HostRow, fingerprint: string): void {
      db.prepare(
        `UPDATE hosts_inventory SET host_key_fingerprint = ?
         WHERE org_id = ? AND id = ? AND host_key_fingerprint IS NULL AND address = ? AND port = ?`
      ).run(fingerprint, orgId, row.id, row.address, row.port);
    },

    // Guarded by the connection settings the collection used, so a result
    // that finishes after an edit cannot overwrite the edited host's state.
    record(row: HostRow, rec: CollectionRecord): void {
      const seen = rec.seen;
      db.prepare(
        `UPDATE hosts_inventory SET status = ?, results = ?, last_collected_at = ?, last_error = ?
           ${seen ? ", detected_kind = ?, facts = ?, filesystems = ?, last_seen_at = ?" : ""}
         WHERE org_id = ? AND id = ? AND address = ? AND port = ? AND username = ? AND auth = ?`
      ).run(
        rec.status,
        JSON.stringify(rec.results),
        rec.at,
        rec.error ?? null,
        ...(seen ? [seen.detectedKind, JSON.stringify(seen.facts), JSON.stringify(seen.filesystems), rec.at] : []),
        orgId,
        row.id,
        row.address,
        row.port,
        row.username,
        row.auth
      );
    },
  };
}

export type HostStore = ReturnType<typeof createStore>;

export function rowResults(row: HostRow): CheckResult[] {
  return parseJson<CheckResult[]>(row.results, []);
}

export function rowFilesystems(row: HostRow): Filesystem[] {
  return parseJson<Filesystem[]>(row.filesystems, []);
}

export function rowPaths(row: HostRow): string[] {
  return parseJson<string[]>(row.backup_target_paths, []);
}

export function toView(row: HostRow, hasCredential: boolean): HostView {
  const facts = parseJson<Facts>(row.facts, {});
  return {
    id: row.id,
    label: row.label,
    address: row.address,
    port: row.port,
    username: row.username,
    auth: row.auth,
    kind: row.kind,
    ...(row.generated_key ? { generatedKey: true } : {}),
    ...(row.detected_kind ? { detectedKind: row.detected_kind } : {}),
    hasCredential,
    backupTargetPaths: rowPaths(row),
    status: row.status,
    ...(row.last_seen_at ? { lastSeenAt: row.last_seen_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(Object.keys(facts).length > 0 ? { facts } : {}),
  };
}

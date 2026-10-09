import type { Database } from "better-sqlite3";
import type { ConnectorView, OwnedRecord, OwnedStore } from "../../contracts/connectors.js";
import type { CheckResult, Status } from "../../contracts/health.js";
import type { DriftReport } from "../../contracts/ownership.js";

export interface InstanceRow {
  id: string;
  kind: string;
  name: string;
  config: string;
  status: string;
  checks: string;
  checked_at: string | null;
  drift: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
}

export class InstanceStore {
  private readonly db: Database;
  private readonly orgId: string;

  constructor(db: Database, orgId: string) {
    this.db = db;
    this.orgId = orgId;
  }

  list(kind?: string): InstanceRow[] {
    const rows = this.db
      .prepare("SELECT * FROM connectors_instances WHERE org_id = ? ORDER BY created_at, id")
      .all(this.orgId) as InstanceRow[];
    return kind === undefined ? rows : rows.filter((r) => r.kind === kind);
  }

  get(id: string): InstanceRow | undefined {
    return this.db.prepare("SELECT * FROM connectors_instances WHERE org_id = ? AND id = ?").get(this.orgId, id) as
      InstanceRow | undefined;
  }

  insert(row: { id: string; kind: string; name: string; config: Record<string, string>; by: string; at: string }) {
    this.db
      .prepare(
        `INSERT INTO connectors_instances (id, org_id, kind, name, config, created_at, created_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, this.orgId, row.kind, row.name, JSON.stringify(row.config), row.at, row.by, row.at);
  }

  update(id: string, name: string, config: Record<string, string>, at: string): void {
    this.db
      .prepare("UPDATE connectors_instances SET name = ?, config = ?, updated_at = ? WHERE org_id = ? AND id = ?")
      .run(name, JSON.stringify(config), at, this.orgId, id);
  }

  setChecks(id: string, status: Status, checks: CheckResult[], at: string): void {
    this.db
      .prepare("UPDATE connectors_instances SET status = ?, checks = ?, checked_at = ? WHERE org_id = ? AND id = ?")
      .run(status, JSON.stringify(checks), at, this.orgId, id);
  }

  setDrift(id: string, drift: DriftReport): void {
    this.db
      .prepare("UPDATE connectors_instances SET drift = ? WHERE org_id = ? AND id = ?")
      .run(JSON.stringify(drift), this.orgId, id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM connectors_owned WHERE org_id = ? AND instance_id = ?").run(this.orgId, id);
    this.db.prepare("DELETE FROM connectors_instances WHERE org_id = ? AND id = ?").run(this.orgId, id);
  }
}

export function toView(row: InstanceRow, secrets: Record<string, boolean>): ConnectorView {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    config: JSON.parse(row.config) as Record<string, string>,
    secrets,
    status: row.status as Status,
    checks: JSON.parse(row.checks) as CheckResult[],
    ...(row.checked_at ? { checkedAt: row.checked_at } : {}),
    ...(row.drift ? { drift: JSON.parse(row.drift) as DriftReport } : {}),
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
  };
}

interface OwnedRow {
  key: string;
  kind: string;
  external_id: string | null;
  spec: string;
  spec_hash: string;
  updated_at: string;
}

const toRecord = (row: OwnedRow): OwnedRecord => ({
  key: row.key,
  kind: row.kind,
  ...(row.external_id ? { externalId: row.external_id } : {}),
  spec: JSON.parse(row.spec) as Record<string, unknown>,
  specHash: row.spec_hash,
  updatedAt: row.updated_at,
});

export function ownedStore(db: Database, orgId: string, instanceId: string, now: () => Date): OwnedStore {
  return {
    list(kind) {
      const rows = db
        .prepare("SELECT * FROM connectors_owned WHERE org_id = ? AND instance_id = ? ORDER BY kind, key")
        .all(orgId, instanceId) as OwnedRow[];
      return rows.filter((r) => kind === undefined || r.kind === kind).map(toRecord);
    },
    get(key, kind) {
      const row = db
        .prepare("SELECT * FROM connectors_owned WHERE org_id = ? AND instance_id = ? AND key = ? AND kind = ?")
        .get(orgId, instanceId, key, kind) as OwnedRow | undefined;
      return row && toRecord(row);
    },
    put(obj) {
      db.prepare(
        `INSERT INTO connectors_owned (org_id, instance_id, key, kind, external_id, spec, spec_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (instance_id, key, kind) DO UPDATE SET external_id = excluded.external_id,
           spec = excluded.spec, spec_hash = excluded.spec_hash, updated_at = excluded.updated_at`
      ).run(
        orgId,
        instanceId,
        obj.key,
        obj.kind,
        obj.externalId ?? null,
        JSON.stringify(obj.spec),
        obj.specHash,
        now().toISOString()
      );
    },
    delete(key, kind) {
      db.prepare("DELETE FROM connectors_owned WHERE org_id = ? AND instance_id = ? AND key = ? AND kind = ?").run(
        orgId,
        instanceId,
        key,
        kind
      );
    },
  };
}

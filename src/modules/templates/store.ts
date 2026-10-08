import type { Database } from "better-sqlite3";
import type { CustomAppSpec } from "../../contracts/templates.js";

export interface InstanceRecord {
  name: string;
  templateId: string;
  version: string;
  host: string;
  volumeSize?: string;
  storageClass?: string;
  custom?: CustomAppSpec;
  lastJobId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  name: string;
  template_id: string;
  version: string;
  host: string;
  volume_size: string | null;
  storage_class: string | null;
  custom: string | null;
  last_job_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function toRecord(row: Row): InstanceRecord {
  return {
    name: row.name,
    templateId: row.template_id,
    version: row.version,
    host: row.host,
    ...(row.volume_size ? { volumeSize: row.volume_size } : {}),
    ...(row.storage_class ? { storageClass: row.storage_class } : {}),
    ...(row.custom ? { custom: JSON.parse(row.custom) as CustomAppSpec } : {}),
    ...(row.last_job_id ? { lastJobId: row.last_job_id } : {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class Store {
  private readonly db: Database;
  private readonly orgId: string;

  constructor(db: Database, orgId: string) {
    this.db = db;
    this.orgId = orgId;
  }

  list(): InstanceRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM templates_instances WHERE org_id = ? ORDER BY updated_at DESC, name")
      .all(this.orgId) as Row[];
    return rows.map(toRecord);
  }

  get(name: string): InstanceRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM templates_instances WHERE org_id = ? AND name = ?")
      .get(this.orgId, name) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  // Keeps created_by and created_at of an instance deployed again.
  save(record: Omit<InstanceRecord, "createdAt" | "updatedAt">, at: string): void {
    this.db
      .prepare(
        `INSERT INTO templates_instances (org_id, name, template_id, version, host, volume_size, storage_class,
           custom, last_job_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (org_id, name) DO UPDATE SET template_id = excluded.template_id, version = excluded.version,
           host = excluded.host, volume_size = excluded.volume_size, storage_class = excluded.storage_class,
           custom = excluded.custom, last_job_id = excluded.last_job_id, updated_at = excluded.updated_at`
      )
      .run(
        this.orgId,
        record.name,
        record.templateId,
        record.version,
        record.host,
        record.volumeSize ?? null,
        record.storageClass ?? null,
        record.custom ? JSON.stringify(record.custom) : null,
        record.lastJobId ?? null,
        record.createdBy,
        at,
        at
      );
  }
}

import type { Database } from "better-sqlite3";
import type { Migration } from "../contracts/runtime.js";

export const DEFAULT_ORG_ID = "default";

// Tables that are bookkeeping for the install as a whole rather than data an
// organisation owns, so they carry no org_id. Everything else must.
export const ORG_EXEMPT_TABLES: readonly string[] = ["schema_migrations", "orgs"];

// Applied as module "runtime", before the platform and every module.
export const runtimeMigrations: readonly Migration[] = [
  {
    version: 1,
    name: "orgs",
    up: `
      CREATE TABLE orgs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO orgs (id, name, created_at)
        VALUES ('${DEFAULT_ORG_ID}', 'Default', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `,
  },
];

export function ensureMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      module TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (module, version)
    )
  `);
}

export function validateMigrations(module: string, migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Migrations for "${module}" must be numbered 1, 2, 3 … in order; position ${index + 1} has version ${migration.version}.`
      );
    }
  });
}

export function schemaVersion(db: Database, module: string): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations WHERE module = ?").get(module) as {
    v: number | null;
  };
  return row.v ?? 0;
}

export interface MigrationOutcome {
  module: string;
  applied: number[];
  version: number;
}

// The read of what is applied and the applying happen inside one IMMEDIATE
// transaction, so two pods starting together cannot both apply a version.
// A version recorded but unknown here was applied by a newer pod during a
// rollout; it is left alone, which is why migrations must be additive.
export function applyMigrations(db: Database, module: string, migrations: readonly Migration[]): MigrationOutcome {
  validateMigrations(module, migrations);
  ensureMigrationsTable(db);
  const applied: number[] = [];
  const run = db.transaction(() => {
    const done = new Set(
      (db.prepare("SELECT version FROM schema_migrations WHERE module = ?").all(module) as { version: number }[]).map(
        (row) => row.version
      )
    );
    const record = db.prepare("INSERT INTO schema_migrations (module, version, name, applied_at) VALUES (?, ?, ?, ?)");
    for (const migration of migrations) {
      if (done.has(migration.version)) continue;
      if (typeof migration.up === "string") db.exec(migration.up);
      else migration.up(db);
      record.run(module, migration.version, migration.name, new Date().toISOString());
      applied.push(migration.version);
    }
  });
  run.immediate();
  return { module, applied, version: schemaVersion(db, module) };
}

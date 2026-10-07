// Guards every module's migrations, so these rules hold for code written
// after the skeleton without anyone remembering them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { modules } from "../../src/modules/index.js";
import { createPlatform } from "../../src/platform/index.js";
import { openDatabase } from "../../src/runtime/db.js";
import { applyMigrations, ORG_EXEMPT_TABLES, runtimeMigrations } from "../../src/runtime/migrations.js";

function migratedDatabase() {
  const db = openDatabase(":memory:");
  applyMigrations(db, "runtime", runtimeMigrations);
  const platform = createPlatform({ db, dataDir: "/tmp", orgId: "default", identify: () => null });
  applyMigrations(db, "platform", platform.migrations);
  for (const mod of modules) applyMigrations(db, mod.id, mod.migrations ?? []);
  return { db, platform };
}

test("every module's migrations apply cleanly from empty", () => {
  migratedDatabase();
});

test("every table carries org_id", () => {
  const { db } = migratedDatabase();
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
  const missing = tables.filter(
    (table) =>
      !ORG_EXEMPT_TABLES.includes(table) &&
      !(db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).some((col) => col.name === "org_id")
  );
  assert.deepEqual(missing, [], `tables without org_id: ${missing.join(", ")}`);
});

// Additive only: during a rollout the old pod keeps running against the new
// schema, so nothing it reads may disappear or be renamed.
test("migrations are additive", () => {
  const { platform } = migratedDatabase();
  const destructive = /\b(DROP\s+(TABLE|COLUMN|INDEX|VIEW|TRIGGER)|RENAME\s+(TO|COLUMN))\b/i;
  const all = [
    ...platform.migrations.map((m) => ({ owner: "platform", m })),
    ...modules.flatMap((mod) => (mod.migrations ?? []).map((m) => ({ owner: mod.id, m }))),
  ];
  const offenders = all.filter(({ m }) => typeof m.up === "string" && destructive.test(m.up));
  assert.deepEqual(
    offenders.map(({ owner, m }) => `${owner} v${m.version}`),
    []
  );
});

test("module tables are prefixed with their module id", () => {
  const offenders: string[] = [];
  for (const mod of modules) {
    const db = openDatabase(":memory:");
    applyMigrations(db, "runtime", runtimeMigrations);
    const before = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name)
    );
    applyMigrations(db, mod.id, mod.migrations ?? []);
    const prefix = `${mod.id.replace(/-/g, "_")}_`;
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[]) {
      if (!before.has(name) && !name.startsWith(prefix)) offenders.push(`${mod.id}: ${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../src/runtime/db.js";
import {
  applyMigrations,
  DEFAULT_ORG_ID,
  runtimeMigrations,
  schemaVersion,
  validateMigrations,
} from "../../src/runtime/migrations.js";
import type { Migration } from "../../src/contracts/runtime.js";

const widgets: Migration[] = [
  {
    version: 1,
    name: "widgets",
    up: "CREATE TABLE demo_widgets (id TEXT PRIMARY KEY, org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id))",
  },
  { version: 2, name: "widget colour", up: "ALTER TABLE demo_widgets ADD COLUMN colour TEXT" },
];

test("runtime migration seeds the default org", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, "runtime", runtimeMigrations);
  const org = db.prepare("SELECT id, name FROM orgs").all();
  assert.deepEqual(org, [{ id: DEFAULT_ORG_ID, name: "Default" }]);
});

test("applies pending migrations in order and records them", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, "runtime", runtimeMigrations);
  const outcome = applyMigrations(db, "demo", widgets);
  assert.deepEqual(outcome, { module: "demo", applied: [1, 2], version: 2 });
  db.prepare("INSERT INTO demo_widgets (id, colour) VALUES ('w1', 'red')").run();
  assert.equal((db.prepare("SELECT org_id FROM demo_widgets").get() as { org_id: string }).org_id, DEFAULT_ORG_ID);
});

test("is idempotent: a second run applies nothing", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, "runtime", runtimeMigrations);
  applyMigrations(db, "demo", widgets);
  assert.deepEqual(applyMigrations(db, "demo", widgets).applied, []);
});

test("an older pod leaves a newer pod's versions alone", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, "runtime", runtimeMigrations);
  applyMigrations(db, "demo", widgets);
  const outcome = applyMigrations(db, "demo", widgets.slice(0, 1));
  assert.deepEqual(outcome.applied, []);
  assert.equal(schemaVersion(db, "demo"), 2);
});

test("versions are tracked per module", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, "runtime", runtimeMigrations);
  applyMigrations(db, "demo", widgets);
  assert.equal(schemaVersion(db, "other"), 0);
  assert.equal(schemaVersion(db, "runtime"), 1);
});

test("rejects gaps and out-of-order versions", () => {
  assert.throws(() => validateMigrations("demo", [widgets[1]!]), /numbered 1, 2, 3/);
  assert.throws(() => validateMigrations("demo", [widgets[0]!, { ...widgets[1]!, version: 3 }]), /numbered/);
});

test("a failing migration rolls back the whole batch", () => {
  const db = openDatabase(":memory:");
  applyMigrations(db, "runtime", runtimeMigrations);
  const broken: Migration[] = [widgets[0]!, { version: 2, name: "broken", up: "ALTER TABLE nope ADD COLUMN x TEXT" }];
  assert.throws(() => applyMigrations(db, "demo", broken));
  assert.equal(schemaVersion(db, "demo"), 0);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'demo_widgets'").get(), undefined);
});

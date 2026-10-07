import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hashPassword, verifyPassword } from "../../src/platform/auth/passwords.js";
import { createUser, updateUser } from "../../src/platform/auth/users.js";
import { cliCore, resetAdmin } from "../../src/platform/cli.js";
import { platformMigrations } from "../../src/platform/migrations.js";
import { createSettings } from "../../src/platform/settings.js";
import { openDatabase } from "../../src/runtime/db.js";
import { applyMigrations, runtimeMigrations } from "../../src/runtime/migrations.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-cli-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

interface RawUser {
  id: number;
  role: string;
  disabled: number;
  must_change_password: number;
  allowed_networks: string;
  password_hash: string;
  totp_secret: string | null;
  totp_enabled_at: number | null;
  recovery_codes: string;
}

function migrated(file = ":memory:") {
  const db = openDatabase(file);
  applyMigrations(db, "runtime", runtimeMigrations);
  applyMigrations(db, "platform", platformMigrations);
  return db;
}

function assertReset(db: ReturnType<typeof migrated>, username: string): RawUser {
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as RawUser | undefined;
  assert.ok(row);
  assert.equal(row.role, "admin");
  assert.equal(row.disabled, 0);
  assert.equal(row.must_change_password, 1);
  assert.equal(row.allowed_networks, "[]");
  assert.equal(row.totp_secret, null);
  assert.equal(row.totp_enabled_at, null);
  assert.equal(row.recovery_codes, "[]");
  const audits = db
    .prepare("SELECT * FROM audit_log WHERE action = 'admin.reset-admin' AND username = ?")
    .all(username);
  assert.equal(audits.length, 1);
  return row;
}

test("reset-admin, run as a program, creates a missing admin with a working temporary password", async () => {
  const file = path.join(root, "cli.db");
  const env: NodeJS.ProcessEnv = { ...process.env, DB_PATH: file };
  delete env.AUTH_PASSWORD_ENABLED;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "src/platform/cli.ts", "reset-admin", "rescue"],
    { cwd: repo, env }
  );
  const match = /Temporary password[^:]*: (\S+)/.exec(stdout);
  assert.ok(match, stdout);
  const db = migrated(file);
  try {
    const row = assertReset(db, "rescue");
    assert.ok(await verifyPassword(row.password_hash, match[1]!));
  } finally {
    db.close();
  }
});

test("reset-admin clears an existing account's lockouts and the password sign-in overrides", async () => {
  const db = migrated();
  const user = createUser(db, {
    orgId: "default",
    username: "boss",
    passwordHash: await hashPassword("old password 123"),
    role: "user",
  });
  updateUser(db, user.id, { allowedNetworks: ["192.0.2.0/24"], disabled: true });
  db.prepare(
    "UPDATE users SET totp_secret = 'sealed', totp_enabled_at = ?, recovery_codes = '[\"x\"]' WHERE id = ?"
  ).run(Date.now(), user.id);
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (id_hash, user_id, method, created_at, last_seen_at, expires_at) VALUES ('h', ?, 'password', ?, ?, ?)"
  ).run(user.id, now, now, now + 60_000);
  const settings = createSettings(db, "default");
  settings.set("auth.password.networks", ["192.0.2.0/24"], "test");
  settings.set("auth.password.enabled", false, "test");

  const outcome = await resetAdmin(cliCore(db), "boss");

  assert.equal(outcome.created, false);
  assert.equal(outcome.passwordsOn, true);
  const row = assertReset(db, "boss");
  assert.equal(row.id, user.id);
  assert.ok(await verifyPassword(row.password_hash, outcome.password));
  assert.equal(await verifyPassword(row.password_hash, "old password 123"), false);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(user.id) as { n: number }).n, 0);
  assert.deepEqual(
    db.prepare("SELECT key FROM settings WHERE key IN ('auth.password.enabled', 'auth.password.networks')").all(),
    []
  );
  db.close();
});

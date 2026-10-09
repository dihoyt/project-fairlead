// Services "signin": the write path a module uses to point OIDC sign-in at
// an app registration it created, and what it may read back.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Database } from "better-sqlite3";
import type { AuditRow } from "../../src/contracts/auth.js";
import type { SignInService } from "../../src/contracts/platform.js";
import { hashPasswordSync, verifyPassword } from "../../src/platform/auth/passwords.js";
import { createUser, recordLogin, userByUsername } from "../../src/platform/auth/users.js";
import { createPlatform } from "../../src/platform/index.js";
import { createSecrets } from "../../src/platform/secrets.js";
import { createSettings } from "../../src/platform/settings.js";
import { openDatabase } from "../../src/runtime/db.js";
import { createRuntime } from "../../src/runtime/index.js";
import { silentLogger } from "../../src/runtime/log.js";
import { TEST_SECRETS_KEY } from "./harness.js";

let db: Database;
let signIn: SignInService;

const client = {
  issuer: "https://login.example.test/tenant/v2.0",
  clientId: "app-1",
  clientSecret: "s3cret",
};

beforeEach(async () => {
  process.env.SECRETS_KEY = TEST_SECRETS_KEY;
  process.env.PUBLIC_ORIGIN = "https://console.example.test";
  delete process.env.OIDC_ISSUER_URL;
  db = openDatabase(":memory:");
  const runtime = await createRuntime({
    db,
    dataDir: "/tmp",
    modules: [],
    createPlatform,
    logFor: () => silentLogger,
  });
  signIn = runtime.services.get("signin");
});
afterEach(() => {
  delete process.env.PUBLIC_ORIGIN;
  delete process.env.OIDC_ISSUER_URL;
  db.close();
});

const auditRows = () => db.prepare("SELECT * FROM audit_log ORDER BY id").all() as AuditRow[];

test("the runtime provides it, and it reports the redirect URI and current client", async () => {
  const view = await signIn.oidc();
  assert.deepEqual(view, {
    enabled: false,
    issuer: "",
    clientId: "",
    hasSecret: false,
    hasKey: false,
    redirectUri: "https://console.example.test/auth/oidc/callback",
    blocked: null,
  });
});

test("setOidcClient saves the secret and only the settings given, audited with the actor", async () => {
  const settings = createSettings(db, "default");
  settings.set("auth.oidc.label", "Keep me", "admin");
  await signIn.setOidcClient({ ...client, adminGroups: ["g-1"], enabled: true }, "connector-entra");

  assert.equal(settings.string("auth.oidc.issuer"), client.issuer);
  assert.equal(settings.string("auth.oidc.clientId"), "app-1");
  assert.equal(settings.bool("auth.oidc.enabled"), true);
  assert.deepEqual(settings.list("auth.oidc.adminGroups"), ["g-1"]);
  assert.equal(settings.string("auth.oidc.label"), "Keep me");
  assert.equal(await createSecrets(db, "default").get("auth", "oidc"), "s3cret");

  const view = await signIn.oidc();
  assert.equal(view.hasSecret, true);
  assert.equal(view.clientId, "app-1");

  const row = auditRows().find((r) => r.action === "auth.oidc.wire");
  assert.ok(row);
  assert.equal(row.username, "connector-entra");
  assert.doesNotMatch(JSON.stringify(auditRows()), /s3cret/);
});

test("without a public URL or SECRETS_KEY nothing is written", async () => {
  delete process.env.PUBLIC_ORIGIN;
  assert.match((await signIn.oidc()).blocked ?? "", /public URL/);
  await assert.rejects(signIn.setOidcClient(client, "x"), /public URL/);
  assert.equal((await signIn.oidc()).redirectUri, "");

  process.env.PUBLIC_ORIGIN = "https://console.example.test";
  delete process.env.SECRETS_KEY;
  await assert.rejects(signIn.setOidcClient(client, "x"), /SECRETS_KEY/);
  process.env.SECRETS_KEY = TEST_SECRETS_KEY;

  assert.equal(await createSecrets(db, "default").has("auth", "oidc"), false);
  assert.equal(createSettings(db, "default").string("auth.oidc.clientId"), "");
});

const bootstrapped = () =>
  createUser(db, {
    orgId: "default",
    username: "admin",
    displayName: "Admin",
    passwordHash: hashPasswordSync("bootstrap-password"),
    role: "admin",
    mustChangePassword: true,
  });

test("seedAdminPassword sets the admin's password with no forced change, audited without the value", async () => {
  bootstrapped();
  assert.equal(await signIn.seedAdminPassword("chosen-in-the-file", "onboarding"), true);
  const admin = userByUsername(db, "admin")!;
  assert.equal(admin.mustChangePassword, false);
  assert.equal(await verifyPassword(admin.passwordHash, "chosen-in-the-file"), true);
  const row = auditRows().find((r) => r.action === "auth.seed-password");
  assert.ok(row);
  assert.equal(row.username, "onboarding");
  assert.doesNotMatch(JSON.stringify(auditRows()), /chosen-in-the-file/);
});

test("seedAdminPassword changes nothing once the admin has signed in, or with no admin", async () => {
  assert.equal(await signIn.seedAdminPassword("chosen-in-the-file", "onboarding"), false);
  const admin = bootstrapped();
  recordLogin(db, admin.id);
  assert.equal(await signIn.seedAdminPassword("chosen-in-the-file", "onboarding"), false);
  const after = userByUsername(db, "admin")!;
  assert.equal(after.mustChangePassword, true);
  assert.equal(await verifyPassword(after.passwordHash, "bootstrap-password"), true);
  assert.equal(auditRows().filter((r) => r.action === "auth.seed-password").length, 0);
});

test("seedAdminPassword refuses a password the policy refuses", async () => {
  bootstrapped();
  await assert.rejects(signIn.seedAdminPassword("short", "onboarding"), /at least 10/);
  assert.equal(userByUsername(db, "admin")!.mustChangePassword, true);
});

test("setPublicUrl saves site.publicUrl unless PUBLIC_ORIGIN locks it", async () => {
  await assert.rejects(signIn.setPublicUrl("https://console.example.com", "onboarding"), /PUBLIC_ORIGIN/);
  delete process.env.PUBLIC_ORIGIN;
  await assert.rejects(signIn.setPublicUrl("ftp://console.example.com", "onboarding"), /http or https/);
  await signIn.setPublicUrl("https://console.example.com/", "onboarding");
  assert.equal(createSettings(db, "default").string("site.publicUrl"), "https://console.example.com");
  assert.equal((await signIn.oidc()).redirectUri, "https://console.example.com/auth/oidc/callback");
  const row = auditRows().find((r) => r.action === "admin.setting-change" && r.target === "site.publicUrl");
  assert.equal(row?.username, "onboarding");
});

// Services "signin": the write path a module uses to point OIDC sign-in at
// an app registration it created, and what it may read back.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Database } from "better-sqlite3";
import type { AuditRow } from "../../src/contracts/auth.js";
import type { SignInService } from "../../src/contracts/platform.js";
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

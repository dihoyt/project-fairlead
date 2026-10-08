import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { ResetResult } from "../../src/contracts/reset.js";
import { modules } from "../../src/modules/index.js";
import { userByUsername } from "../../src/platform/auth/users.js";
import { verifyPassword } from "../../src/platform/auth/passwords.js";
import { boot, type Booted } from "./harness.js";

let app: Booted;
let cookie = "";

beforeEach(async () => {
  app = await boot({ modules });
  await app.makeUser("admin", "initial password!!", { role: "admin" });
  cookie = (await app.login("admin", "initial password!!")).cookie;
});
afterEach(() => app.close());

const reset = (scopes: string[], confirm = "RESET", as = cookie) =>
  app.send("POST", "/api/system/reset", { scopes, confirm }, as);

const override = (key: string, value: unknown) =>
  app.db
    .prepare("INSERT INTO settings (key, org_id, value, updated_by, updated_at) VALUES (?, 'default', ?, 'test', 0)")
    .run(key, JSON.stringify(value));
const overrides = () =>
  (app.db.prepare("SELECT key FROM settings ORDER BY key").all() as Array<{ key: string }>).map((r) => r.key);
const count = (table: string) => (app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test("refuses a wrong confirmation, no scopes, an unknown scope and non-admins", async () => {
  assert.equal((await reset(["settings"], "reset")).status, 400);
  assert.equal((await reset([])).status, 400);
  assert.equal((await reset(["everything"])).status, 400);
  await app.makeUser("plain", "plain password!");
  const plain = (await app.login("plain", "plain password!")).cookie;
  assert.equal((await reset(["settings"], "RESET", plain)).status, 403);
});

test("settings spares links and sign-in; links clears only links", async () => {
  override("hosts.intervalSeconds", 120);
  override("health.links", { cluster: [{ label: "x", url: "https://example.com" }] });
  override("longhorn.uiUrl", "https://longhorn.example.com");
  override("auth.password.enabled", true);
  override("site.name", "Kept");

  const first = (await (await reset(["settings"])).json()) as ResetResult;
  assert.equal(first.cleared[0]?.cleared, 1);
  assert.deepEqual(overrides(), ["auth.password.enabled", "health.links", "longhorn.uiUrl", "site.name"]);

  const second = (await (await reset(["links"])).json()) as ResetResult;
  assert.equal(second.cleared[0]?.cleared, 2);
  assert.deepEqual(overrides(), ["auth.password.enabled", "site.name"]);
  assert.ok(second.kept.includes("settings"));
});

test("onboarding clears the wizard marks and says the wizard reopens", async () => {
  app.db
    .prepare(
      "INSERT INTO onboarding_steps (org_id, step, state, updated_by, updated_at) VALUES ('default','hosts','done','t','t')"
    )
    .run();
  const body = (await (await reset(["onboarding"])).json()) as ResetResult;
  assert.deepEqual(body.cleared, [{ scope: "onboarding", cleared: 1 }]);
  assert.equal(body.wizardReopens, true);
  assert.equal(count("onboarding_steps"), 0);
});

test("checks, hosts and notifications go with their stored secrets; deploy history stays", async () => {
  const now = new Date().toISOString();
  const checks = await app.send(
    "POST",
    "/api/checks",
    { label: "Site", kind: "http", target: "https://example.com", authHeader: "Authorization", secret: "Bearer x" },
    cookie
  );
  assert.equal(checks.status, 200, await checks.clone().text());
  const channel = await app.send(
    "POST",
    "/api/notify/channels",
    { kind: "ntfy", label: "Phone", config: { server: "https://ntfy.example.com", topic: "t" }, secret: "tok" },
    cookie
  );
  assert.equal(channel.status, 200, await channel.clone().text());
  app.db
    .prepare(
      "INSERT INTO deploy_jobs (id, app_id, release, namespace, version, mode, state, started_by, created_at, job_namespace, job_name) VALUES ('j','a','r','n','1','install','succeeded','t',?,'ns','job')"
    )
    .run(now);

  const body = (await (await reset(["checks", "notifications"])).json()) as ResetResult;
  assert.equal(count("checks_targets"), 0);
  assert.equal(count("notify_channels"), 0);
  assert.equal(count("secrets"), 0);
  assert.equal(count("deploy_jobs"), 1);
  assert.deepEqual(
    body.cleared.map((c) => c.scope),
    ["checks", "notifications"]
  );
});

test("adminPassword gives the built-in admin a temporary password that must be changed", async () => {
  const body = (await (await reset(["adminPassword"])).json()) as ResetResult;
  assert.ok(body.temporaryPassword);
  const row = userByUsername(app.db, "admin")!;
  assert.equal(await verifyPassword(row.passwordHash, body.temporaryPassword!), true);
  assert.equal(Boolean(row.mustChangePassword), true);
  assert.equal((await reset(["settings"])).headers.get("content-type")?.includes("json"), true);
});

test("the reset is audited", async () => {
  await reset(["links"]);
  const row = app.db.prepare("SELECT action, username FROM audit_log WHERE action = 'system.reset'").get() as {
    username: string;
  };
  assert.equal(row.username, "admin");
});

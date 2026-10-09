import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, test } from "node:test";
import { boot, TEST_SECRETS_KEY, type Booted } from "./harness.js";

const PASSWORD = "correct horse battery";
const PASSPHRASE = "a long kit passphrase";
const hasOpenssl = spawnSync("sh", ["-c", "command -v openssl"]).status === 0;

let app: Booted;

beforeEach(async () => {
  app = await boot({ env: { HELM_RELEASE: "console", POD_NAMESPACE: "ops" } });
});
afterEach(async () => {
  delete process.env.HELM_RELEASE;
  delete process.env.POD_NAMESPACE;
  await app.close();
});

async function admin() {
  await app.makeUser("root", PASSWORD, { role: "admin" });
  return (await app.login("root", PASSWORD)).cookie;
}

test("the kit opens with openssl and the passphrase, and holds the key", { skip: !hasOpenssl }, async () => {
  const cookie = await admin();
  const res = await app.send("POST", "/api/admin/recovery-kit", { passphrase: PASSPHRASE, password: PASSWORD }, cookie);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename=".+-recovery-kit\.txt"/);
  const kit = await res.text();
  assert.match(kit, /^# .+ recovery kit\n# release: console {2}namespace: ops/);
  const sealed = kit
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .join("");
  const opened = spawnSync(
    "openssl",
    ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "600000", "-md", "sha256", "-a", "-A", "-pass", "env:KIT_PASS"],
    { input: sealed, encoding: "utf8", env: { ...process.env, KIT_PASS: PASSPHRASE } }
  );
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stdout, new RegExp(`^SECRETS_KEY=${TEST_SECRETS_KEY}\nRELEASE=console\nNAMESPACE=ops\n`));
  assert.match(opened.stdout, /KIT_VERSION=1\n$/);

  const wrong = spawnSync(
    "openssl",
    ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "600000", "-md", "sha256", "-a", "-A", "-pass", "pass:nope"],
    { input: sealed, encoding: "utf8" }
  );
  assert.ok(wrong.status !== 0 || !wrong.stdout.includes(TEST_SECRETS_KEY));

  const audit = await (await app.get("/api/admin/audit", cookie)).json();
  assert.ok((audit as Array<{ action: string }>).some((row) => row.action === "admin.recovery-kit"));
});

test("a wrong password, a short passphrase or a non-admin gets no kit", async () => {
  const cookie = await admin();
  const short = await app.send("POST", "/api/admin/recovery-kit", { passphrase: "short", password: PASSWORD }, cookie);
  assert.equal(short.status, 400);
  const wrong = await app.send("POST", "/api/admin/recovery-kit", { passphrase: PASSPHRASE, password: "nope" }, cookie);
  assert.equal(wrong.status, 401);
  assert.doesNotMatch(await wrong.text(), new RegExp(TEST_SECRETS_KEY));

  await app.makeUser("bob", PASSWORD);
  const member = (await app.login("bob", PASSWORD)).cookie;
  const refused = await app.send(
    "POST",
    "/api/admin/recovery-kit",
    { passphrase: PASSPHRASE, password: PASSWORD },
    member
  );
  assert.equal(refused.status, 403);
});

test("without SECRETS_KEY there is nothing to keep", async () => {
  const cookie = await admin();
  delete process.env.SECRETS_KEY;
  const res = await app.send("POST", "/api/admin/recovery-kit", { passphrase: PASSPHRASE, password: PASSWORD }, cookie);
  assert.equal(res.status, 409);
});

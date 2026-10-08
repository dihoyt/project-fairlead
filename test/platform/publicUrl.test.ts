// The public URL: PUBLIC_ORIGIN beats a saved value, a saved value beats
// the request's own address, and only the environment turns on Secure
// cookies.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { AdminOverview } from "../../src/contracts/auth.js";
import { boot, type Booted } from "./harness.js";

let app: Booted;
let adminCookie = "";

beforeEach(async () => {
  app = await boot();
  await app.makeUser("root", "root password!!", { role: "admin" });
  adminCookie = (await app.login("root", "root password!!")).cookie;
});
afterEach(() => app.close());

// An https PUBLIC_ORIGIN renames the session cookie with the __Host- prefix.
const cookie = () => (process.env.PUBLIC_ORIGIN?.startsWith("https://") ? `__Host-${adminCookie}` : adminCookie);

const overview = async (headers: Record<string, string> = {}): Promise<AdminOverview> =>
  (await (await app.get("/api/admin/overview", cookie(), headers)).json()) as AdminOverview;

const savePublicUrl = (value: string) => app.send("PUT", "/api/admin/settings/site.publicUrl", { value }, cookie());

test("PUBLIC_ORIGIN wins and the setting is shown locked", async () => {
  process.env.PUBLIC_ORIGIN = "https://console.example.com/";
  const body = await overview();
  assert.deepEqual(body.publicUrl, { value: "https://console.example.com", source: "env" });
  assert.equal(body.oidc.redirectUri, "https://console.example.com/auth/oidc/callback");
  const setting = body.settings.find((s) => s.key === "site.publicUrl");
  assert.equal(setting?.locked, true);
  assert.equal(setting?.source, "env");
  assert.equal(
    body.environment.find((e) => e.name === "PUBLIC_ORIGIN"),
    undefined
  );
  assert.equal((await savePublicUrl("https://other.example.com")).status, 409);
});

test("a saved value applies when the environment has none, and an env value later overrides it", async () => {
  delete process.env.PUBLIC_ORIGIN;
  assert.equal((await savePublicUrl("https://console.example.com/")).status, 200);
  let body = await overview();
  assert.deepEqual(body.publicUrl, { value: "https://console.example.com", source: "ui" });
  assert.equal(body.oidc.redirectUri, "https://console.example.com/auth/oidc/callback");
  assert.equal(body.settings.find((s) => s.key === "site.publicUrl")?.locked, undefined);

  process.env.PUBLIC_ORIGIN = "https://env.example.com";
  body = await overview();
  assert.deepEqual(body.publicUrl, { value: "https://env.example.com", source: "env" });
});

test("with nothing configured the redirect URI comes from the request's address", async () => {
  delete process.env.PUBLIC_ORIGIN;
  const body = await overview();
  assert.deepEqual(body.publicUrl, { value: app.url, source: "request" });
  assert.equal(body.oidc.redirectUri, `${app.url}/auth/oidc/callback`);
});

test("forwarded scheme and host are believed only from a trusted proxy", async () => {
  delete process.env.PUBLIC_ORIGIN;
  const forwarded = { "x-forwarded-proto": "https", "x-forwarded-host": "console.example.com" };
  assert.equal((await overview(forwarded)).publicUrl.value, app.url);
  process.env.TRUSTED_PROXIES = "127.0.0.1";
  assert.equal((await overview(forwarded)).publicUrl.value, "https://console.example.com");
});

test("a saved https URL does not make the session cookie Secure", async () => {
  delete process.env.PUBLIC_ORIGIN;
  assert.equal((await savePublicUrl("https://console.example.com")).status, 200);
  const { res, cookie: fresh } = await app.login("root", "root password!!");
  assert.equal(res.status, 200);
  assert.ok(fresh && !fresh.startsWith("__Host-"));
  assert.ok(!res.headers.getSetCookie().some((line) => /;\s*Secure/i.test(line)));
});

test("mutations from the saved URL's origin or the request's own address pass; others are refused", async () => {
  delete process.env.PUBLIC_ORIGIN;
  assert.equal((await savePublicUrl("https://console.example.com")).status, 200);
  const post = (origin: string) =>
    fetch(`${app.url}/api/admin/settings/site.name`, {
      method: "PUT",
      headers: { cookie: adminCookie, "content-type": "application/json", origin },
      body: JSON.stringify({ value: "x" }),
    });
  assert.equal((await post(app.url)).status, 200);
  assert.equal((await post("https://console.example.com")).status, 200);
  assert.equal((await post("https://evil.example.com")).status, 403);
});

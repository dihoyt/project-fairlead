import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { AuditRow, UserView } from "../../src/contracts/auth.js";
import { createUser, userByUsername } from "../../src/platform/auth/users.js";
import { product } from "../../src/product.js";
import { boot, type Booted } from "./harness.js";

let app: Booted;
let adminCookie = "";

beforeEach(async () => {
  app = await boot();
  await app.makeUser("root", "root password!!", { role: "admin" });
  adminCookie = await signIn("root", "root password!!");
});
afterEach(() => app.close());

async function signIn(username: string, password: string): Promise<string> {
  const { res, cookie } = await app.login(username, password);
  assert.equal(res.status, 200, `sign-in as ${username}`);
  return cookie;
}

const call = (method: string, route: string, body?: unknown, cookie = adminCookie) =>
  app.send(method, `/api/admin${route}`, body, cookie);

const plainUser = (username: string, role: "admin" | "user" = "user") =>
  createUser(app.db, { orgId: "default", username, passwordHash: null, role });

test("a non-admin is refused every admin route", async () => {
  await app.makeUser("plain", "plain password!");
  const cookie = await signIn("plain", "plain password!");
  assert.equal((await call("GET", "/overview", undefined, cookie)).status, 403);
  assert.equal((await call("PUT", "/settings/site.name", { value: "x" }, cookie)).status, 403);
  assert.equal((await call("GET", "/users", undefined, cookie)).status, 403);
  assert.equal((await call("GET", "/audit", undefined, cookie)).status, 403);
  assert.equal((await call("GET", "/users")).status, 200);
});

test("the overview reports settings with their source, env-only values, and the caller's IP", async () => {
  const body = (await (await call("GET", "/overview")).json()) as {
    settings: { key: string; source: string }[];
    environment: { name: string; value: string }[];
    you: { ip: string };
    oidc: { redirectUri: string; hasSecret: boolean };
    secretKeyConfigured: boolean;
  };
  assert.equal(body.settings.find((s) => s.key === "site.name")?.source, "default");
  assert.equal(body.environment.find((e) => e.name === "SECRETS_KEY")?.value, "(set)");
  assert.equal(body.you.ip, "127.0.0.1");
  assert.equal(body.oidc.redirectUri, `${app.url}/auth/oidc/callback`);
  assert.equal(body.oidc.hasSecret, false);
  assert.equal(body.secretKeyConfigured, true);
});

test("a setting is saved, audited, and reset", async () => {
  assert.equal((await call("PUT", "/settings/site.name", { value: "My Site" })).status, 200);
  const methods = (await (await app.get("/api/auth/methods")).json()) as { siteName: string };
  assert.equal(methods.siteName, "My Site");
  const audit = (await (await call("GET", "/audit")).json()) as AuditRow[];
  assert.ok(audit.some((row) => row.action === "admin.setting-change" && row.target === "site.name"));
  const reset = (await (await call("DELETE", "/settings/site.name")).json()) as { value: string };
  assert.equal(reset.value, product.displayName);
  assert.equal(
    ((await (await app.get("/api/auth/methods")).json()) as { siteName: string }).siteName,
    product.displayName
  );
});

test("a setting of the wrong shape or an unknown key is refused", async () => {
  assert.equal((await call("PUT", "/settings/auth.session.idleDays", { value: 0 })).status, 400);
  assert.equal((await call("PUT", "/settings/auth.password.networks", { value: ["not a cidr"] })).status, 400);
  assert.equal((await call("PUT", "/settings/no.such.setting", { value: "x" })).status, 404);
});

test("password sign-in cannot be turned off before OIDC works for the admin", async () => {
  assert.equal((await call("PUT", "/settings/auth.password.enabled", { value: false })).status, 409);
});

test("an admin cannot save a method-wide network list that excludes them", async () => {
  assert.equal((await call("PUT", "/settings/auth.password.networks", { value: ["192.0.2.0/24"] })).status, 409);
  assert.equal((await call("PUT", "/settings/auth.password.networks", { value: ["127.0.0.0/8"] })).status, 200);
});

test("an admin cannot give themselves a network rule that excludes them, but can restrict others", async () => {
  const me = userByUsername(app.db, "root")!;
  assert.equal((await call("PATCH", `/users/${me.id}`, { allowedNetworks: ["192.0.2.0/24"] })).status, 409);
  assert.equal((await call("PATCH", `/users/${me.id}`, { allowedNetworks: ["127.0.0.1"] })).status, 200);
  const other = plainUser("other");
  assert.equal((await call("PATCH", `/users/${other.id}`, { allowedNetworks: ["192.0.2.0/24"] })).status, 200);
  assert.equal((await call("PATCH", `/users/${other.id}`, { allowedNetworks: ["bogus"] })).status, 400);
});

test("the last admin cannot be disabled, demoted or deleted, and nobody can disable themselves", async () => {
  const me = userByUsername(app.db, "root")!;
  assert.equal((await call("PATCH", `/users/${me.id}`, { disabled: true })).status, 409);
  assert.equal((await call("PATCH", `/users/${me.id}`, { role: "user" })).status, 409);
  const second = plainUser("second", "admin");
  // With another admin present, that admin can be demoted, but not the last
  // one left after it.
  assert.equal((await call("PATCH", `/users/${second.id}`, { role: "user" })).status, 200);
  assert.equal((await call("DELETE", `/users/${me.id}`)).status, 409);
});

test("creating a user returns a one-time password that must be changed", async () => {
  const res = await call("POST", "/users", { username: "New.Person", role: "user" });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { user: UserView; temporaryPassword: string };
  assert.equal(body.user.username, "new.person");
  assert.equal(body.user.mustChangePassword, true);
  assert.equal(body.user.hasPassword, true);
  assert.match(body.user.createdAt, /^\d{4}-\d\d-\d\dT/);
  const cookie = await signIn("new.person", body.temporaryPassword);
  const me = (await (await app.get("/api/me", cookie)).json()) as { mustChangePassword: boolean };
  assert.equal(me.mustChangePassword, true);
  assert.equal((await call("POST", "/users", { username: "new.person" })).status, 409);
  assert.equal((await call("POST", "/users", { username: "Bad Name!" })).status, 400);
});

test("a user created with password null can only be claimed through OIDC", async () => {
  const res = await call("POST", "/users", { username: "sso.only", password: null });
  const body = (await res.json()) as { user: UserView; temporaryPassword: string | null };
  assert.equal(res.status, 201);
  assert.equal(body.temporaryPassword, null);
  assert.equal(body.user.hasPassword, false);
  assert.equal(body.user.mustChangePassword, false);
});

test("a password reset ends the user's sessions", async () => {
  const created = (await (await call("POST", "/users", { username: "resetme" })).json()) as {
    user: { id: number };
    temporaryPassword: string;
  };
  const cookie = await signIn("resetme", created.temporaryPassword);
  const reset = (await (await call("POST", `/users/${created.user.id}/password`)).json()) as {
    temporaryPassword: string;
  };
  assert.notEqual(reset.temporaryPassword, created.temporaryPassword);
  assert.equal((await app.get("/api/me", cookie)).status, 401);
});

test("an admin can see and revoke another user's sessions", async () => {
  const created = (await (await call("POST", "/users", { username: "sess" })).json()) as {
    user: { id: number };
    temporaryPassword: string;
  };
  const cookie = await signIn("sess", created.temporaryPassword);
  const list = (await (await call("GET", `/users/${created.user.id}/sessions`)).json()) as { id: string }[];
  assert.equal(list.length, 1);
  assert.equal((await call("DELETE", `/users/${created.user.id}/sessions/${list[0]!.id}`)).status, 200);
  assert.equal((await app.get("/api/me", cookie)).status, 401);
  await signIn("sess", created.temporaryPassword);
  await signIn("sess", created.temporaryPassword);
  const all = (await (await call("DELETE", `/users/${created.user.id}/sessions`)).json()) as { ended: number };
  assert.equal(all.ended, 2);
});

test("deleting a user removes the account, and is audited", async () => {
  const doomed = plainUser("doomed");
  assert.equal((await call("DELETE", `/users/${doomed.id}`)).status, 200);
  assert.equal(userByUsername(app.db, "doomed"), null);
  assert.equal((await call("DELETE", `/users/${doomed.id}`)).status, 404);
  const audit = (await (await call("GET", "/audit?limit=5")).json()) as AuditRow[];
  assert.ok(audit.some((row) => row.action === "admin.user-delete" && row.target === "doomed"));
});

test("the OIDC client secret is write-only, and stored sealed", async () => {
  assert.equal((await call("PUT", "/oidc/secret", { value: "s3cret-value" })).status, 200);
  const overview = await (await call("GET", "/overview")).text();
  assert.ok(!overview.includes("s3cret-value"));
  assert.ok(overview.includes('"hasSecret":true'));
  const row = app.db.prepare("SELECT ciphertext FROM secrets WHERE scope = 'auth' AND id = 'oidc'").get() as {
    ciphertext: string;
  };
  assert.ok(!row.ciphertext.includes("s3cret-value"));
  assert.equal((await call("PUT", "/oidc/secret", { value: "" })).status, 200);
  assert.ok((await (await call("GET", "/overview")).text()).includes('"hasSecret":false'));
});

test("the audit log pages backwards by id", async () => {
  for (const name of ["a1", "a2", "a3"]) await call("POST", "/users", { username: name, password: null });
  const first = (await (await call("GET", "/audit?limit=2")).json()) as AuditRow[];
  assert.equal(first.length, 2);
  assert.ok(first[0]!.id > first[1]!.id);
  const next = (await (await call("GET", `/audit?limit=2&before=${first[1]!.id}`)).json()) as AuditRow[];
  assert.ok(next.every((row) => row.id < first[1]!.id));
});

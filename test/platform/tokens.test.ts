import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { ApiTokenView, Me, NewApiToken } from "../../src/contracts/auth.js";
import type { Module } from "../../src/contracts/module.js";
import { updateUser, userByUsername } from "../../src/platform/auth/users.js";
import { boot, type Booted } from "./harness.js";

// A route that needs "write", to see a token's scope applied.
const probe: Module = {
  id: "mcp",
  milestone: "A",
  register(ctx) {
    ctx.route("POST /api/mcp", (req, res) => {
      const user = ctx.require(req, res, "write");
      return user ? { jsonrpc: "2.0", result: { id: user.id, source: user.source } } : undefined;
    });
  },
};

let app: Booted;
let cookie = "";

beforeEach(async () => {
  app = await boot({ modules: [probe] });
  await app.makeUser("root", "root password!!", { role: "admin" });
  cookie = (await app.login("root", "root password!!")).cookie;
});
afterEach(() => app.close());

async function mint(body: Record<string, unknown>): Promise<NewApiToken> {
  const res = await app.send("POST", "/api/admin/tokens", body, cookie);
  assert.equal(res.status, 200);
  return (await res.json()) as NewApiToken;
}

const bearer = (secret: string, method = "GET", path = "/api/me") =>
  fetch(`${app.url}${path}`, { method, headers: { authorization: `Bearer ${secret}` } });

test("a token is shown once, stored hashed, and signs requests in as its creator", async () => {
  const { token, secret } = await mint({ name: "Claude Code", scope: "write" });
  assert.match(secret, /^api_[A-Za-z0-9_-]{43}$/);
  assert.equal(token.prefix, secret.slice(0, 8));
  assert.equal(token.createdBy, "root");
  assert.equal(token.expiresAt, null);
  const stored = app.db.prepare("SELECT * FROM api_tokens").all() as Array<Record<string, unknown>>;
  assert.equal(stored.length, 1);
  assert.ok(!JSON.stringify(stored).includes(secret));

  const me = (await (await bearer(secret)).json()) as Me;
  assert.equal(me.id, "root");
  assert.equal(me.source, "token");
  const write = await bearer(secret, "POST", "/api/mcp");
  assert.equal(write.status, 200);

  const list = (await (await app.get("/api/admin/tokens", cookie)).json()) as ApiTokenView[];
  assert.equal(list[0]?.id, token.id);
  assert.ok(list[0]?.lastUsedAt);
  assert.ok(!JSON.stringify(list).includes(secret));
});

test("a read token can only read", async () => {
  const { secret } = await mint({ name: "reader", scope: "read" });
  assert.equal((await bearer(secret)).status, 200);
  assert.equal((await bearer(secret, "POST", "/api/mcp")).status, 403);
});

test("tokens are refused on admin and auth routes, even write tokens", async () => {
  const { secret } = await mint({ name: "w", scope: "write" });
  assert.equal((await bearer(secret, "GET", "/api/admin/tokens")).status, 403);
  assert.equal((await bearer(secret, "GET", "/api/admin/users")).status, 403);
  assert.equal((await bearer(secret, "GET", "/api/auth/account")).status, 403);
});

test("a bad, revoked or expired token is a 401 and never falls back to the cookie", async () => {
  const { token, secret } = await mint({ name: "w", scope: "write", expiresInDays: 1 });
  assert.ok(token.expiresAt);
  assert.equal((await bearer("api_nope")).status, 401);
  assert.equal((await bearer("not-ours")).status, 401);
  const both = await fetch(`${app.url}/api/me`, { headers: { authorization: "Bearer api_nope", cookie } });
  assert.equal(both.status, 401);

  app.db.prepare("UPDATE api_tokens SET expires_at = ?").run(Date.now() - 1000);
  assert.equal((await bearer(secret)).status, 401);
  app.db.prepare("UPDATE api_tokens SET expires_at = NULL").run();
  assert.equal((await bearer(secret)).status, 200);

  assert.equal((await app.send("DELETE", `/api/admin/tokens/${token.id}`, undefined, cookie)).status, 200);
  assert.equal((await bearer(secret)).status, 401);
  assert.equal((await app.send("DELETE", `/api/admin/tokens/${token.id}`, undefined, cookie)).status, 404);
});

test("a token follows its account: disabled stops it, a demoted admin can only read", async () => {
  const { secret } = await mint({ name: "w", scope: "write" });
  const root = userByUsername(app.db, "root")!;
  updateUser(app.db, root.id, { role: "user" });
  assert.equal((await bearer(secret, "POST", "/api/mcp")).status, 403);
  const list = (await (await app.get("/api/admin/tokens", cookie)).json()) as unknown;
  assert.equal((list as { error?: string }).error, "Admins only.");
  updateUser(app.db, root.id, { role: "admin", disabled: true });
  assert.equal((await bearer(secret)).status, 401);
});

test("creation validates its input and is audited", async () => {
  for (const body of [
    { name: "", scope: "read" },
    { name: "x".repeat(81), scope: "read" },
    { name: "x", scope: "admin" },
    { name: "x", scope: "read", expiresInDays: 0 },
    { name: "x", scope: "read", expiresInDays: 1.5 },
  ]) {
    assert.equal((await app.send("POST", "/api/admin/tokens", body, cookie)).status, 400, JSON.stringify(body));
  }
  await mint({ name: "audited", scope: "read" });
  const audit = app.db.prepare("SELECT action, detail FROM audit_log WHERE action = 'admin.token-create'").all();
  assert.deepEqual(audit, [{ action: "admin.token-create", detail: "audited (read)" }]);
});

// Routes in two areas, one namespaced, to see a grant applied end to end.
const scoped: Module[] = [
  {
    id: "workloads",
    milestone: "A",
    register(ctx) {
      ctx.route("GET /api/workloads/namespaces/:namespace/pods", () => []);
    },
  },
  {
    id: "checks",
    milestone: "A",
    register(ctx) {
      ctx.route("GET /api/checks", () => []);
    },
  },
];

test("a grant limits a token to its areas and namespaces, and can be changed", async () => {
  await app.close();
  app = await boot({ modules: scoped });
  await app.makeUser("root", "root password!!", { role: "admin" });
  cookie = (await app.login("root", "root password!!")).cookie;

  const { token, secret } = await mint({ name: "ci", scope: "read", areas: ["workloads"], namespaces: ["apps"] });
  assert.deepEqual([token.areas, token.namespaces], [["workloads"], ["apps"]]);
  assert.equal((await bearer(secret, "GET", "/api/workloads/namespaces/apps/pods")).status, 200);
  assert.equal((await bearer(secret, "GET", "/api/workloads/namespaces/other/pods")).status, 403);
  assert.equal((await bearer(secret, "GET", "/api/checks")).status, 403);
  assert.equal((await bearer(secret)).status, 200);

  const res = await app.send("PATCH", `/api/admin/tokens/${token.id}`, { areas: null, namespaces: ["other"] }, cookie);
  assert.equal(res.status, 200);
  const changed = (await res.json()) as ApiTokenView;
  assert.equal(changed.areas, undefined);
  assert.deepEqual(changed.namespaces, ["other"]);
  assert.equal((await bearer(secret, "GET", "/api/workloads/namespaces/other/pods")).status, 200);
  assert.equal((await bearer(secret, "GET", "/api/workloads/namespaces/apps/pods")).status, 403);
  assert.equal((await bearer(secret, "GET", "/api/checks")).status, 200);

  assert.equal((await app.send("PATCH", "/api/admin/tokens/tok_nope", { name: "x" }, cookie)).status, 404);
  const audit = app.db.prepare("SELECT detail FROM audit_log WHERE action = 'admin.token-update'").all();
  assert.deepEqual(audit, [{ detail: "ci (read; namespaces other)" }]);
});

test("a token stored before grants reaches everything", async () => {
  const { secret } = await mint({ name: "old", scope: "write" });
  const stored = app.db.prepare("SELECT namespaces, areas FROM api_tokens").get();
  assert.deepEqual(stored, { namespaces: null, areas: null });
  assert.equal((await bearer(secret, "POST", "/api/mcp")).status, 200);
});

test("grant limits are validated", async () => {
  for (const body of [
    { name: "x", scope: "read", areas: [] },
    { name: "x", scope: "read", areas: ["admin"] },
    { name: "x", scope: "read", namespaces: [] },
    { name: "x", scope: "read", namespaces: ["Not_A_Namespace"] },
    { name: "x", scope: "read", namespaces: "apps" },
  ]) {
    assert.equal((await app.send("POST", "/api/admin/tokens", body, cookie)).status, 400, JSON.stringify(body));
  }
});

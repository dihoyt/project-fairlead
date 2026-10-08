import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../src/app.js";
import type { Module } from "../../src/contracts/module.js";
import { INTERNAL_CALL_HEADER } from "../../src/contracts/platform.js";
import { mockAdmin } from "../../src/contracts/mocks/context.js";
import { createPlatform } from "../../src/platform/index.js";
import { openDatabase } from "../../src/runtime/db.js";
import { HttpError, routeUrl } from "../../src/runtime/http.js";
import { createRuntime } from "../../src/runtime/index.js";
import { silentLogger } from "../../src/runtime/log.js";
import { listen } from "./helpers.js";

// Only a request carrying x-test-user has an identity of its own, so an
// internal call can only succeed on the identity vouched for it.
async function boot(register: Module["register"]) {
  const db = openDatabase(":memory:");
  const runtime = await createRuntime({
    db,
    dataDir: "/tmp",
    modules: [{ id: "mcp", milestone: "A", register }],
    createPlatform,
    identify: (req) => (req.get("x-test-user") ? { ...mockAdmin, id: req.get("x-test-user")! } : null),
    logFor: () => silentLogger,
  });
  const server = await listen(createApp(runtime, { version: "test" }));
  return {
    url: server.url,
    async close() {
      await server.close();
      await runtime.stop();
      db.close();
    },
  };
}

test("routeUrl fills params and appends the query", () => {
  assert.deepEqual(
    routeUrl("GET /api/workloads/namespaces/:namespace/pods", {
      params: { namespace: "a b" },
      query: { workload: "web" },
    }),
    { method: "GET", path: "/api/workloads/namespaces/a%20b/pods?workload=web" }
  );
  assert.throws(() => routeUrl("GET /api/hosts/:id"), /needs param "id"/);
});

test("ctx.call reaches another route as the caller, through /mcp too", async () => {
  const app = await boot((ctx) => {
    ctx.route("GET /api/mcp", async (req) => {
      const modules = await ctx.call(req, "GET /api/system/modules");
      const me = await ctx.call(req, "GET /api/me");
      return { error: `${modules.length} ${me.id}` };
    });
  });
  try {
    for (const path of ["/api/mcp", "/mcp"]) {
      const res = await fetch(`${app.url}${path}`, { headers: { "x-test-user": "dana" } });
      assert.equal(res.status, 200, path);
      assert.deepEqual(await res.json(), { error: "1 dana" });
    }
  } finally {
    await app.close();
  }
});

test("ctx.call rejects with the route's status and message", async () => {
  const app = await boot((ctx) => {
    ctx.route("GET /api/mcp", async (req) => {
      try {
        await ctx.call(req, "GET /api/hosts");
        return { error: "no error" };
      } catch (err) {
        assert.ok(err instanceof HttpError);
        return { error: `${err.status} ${err.message}` };
      }
    });
  });
  try {
    const res = await fetch(`${app.url}/api/mcp`, { headers: { "x-test-user": "dana" } });
    assert.deepEqual(await res.json(), { error: "404 Not found." });
  } finally {
    await app.close();
  }
});

test("a ticket the process did not mint is refused", async () => {
  const app = await boot(() => {});
  try {
    const res = await fetch(`${app.url}/api/me`, { headers: { [INTERNAL_CALL_HEADER]: "forged", "x-test-user": "x" } });
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../src/app.js";
import { modules } from "../../src/modules/index.js";
import { MODULE_IDS, type Module } from "../../src/contracts/module.js";
import { createPlatform } from "../../src/platform/index.js";
import { openDatabase } from "../../src/runtime/db.js";
import { createRuntime } from "../../src/runtime/index.js";
import { silentLogger } from "../../src/runtime/log.js";
import { mockAdmin, mockViewer } from "../../src/contracts/mocks/context.js";
import type { User } from "../../src/contracts/platform.js";
import { listen } from "./helpers.js";

async function boot(extra: { modules?: readonly Module[]; user?: User | null } = {}) {
  const db = openDatabase(":memory:");
  const user = extra.user === undefined ? mockAdmin : extra.user;
  const runtime = await createRuntime({
    db,
    dataDir: "/tmp",
    modules: extra.modules ?? modules,
    createPlatform,
    identify: () => user,
    logFor: () => silentLogger,
  });
  const server = await listen(createApp(runtime, { version: "test" }));
  return {
    runtime,
    url: server.url,
    async close() {
      await server.close();
      await runtime.stop();
      db.close();
    },
  };
}

test("the module list is every planned module, each once", () => {
  assert.deepEqual(modules.map((m) => m.id).toSorted(), [...MODULE_IDS].toSorted());
});

test("starts with every module registered and its migrations applied", async () => {
  const app = await boot();
  try {
    const res = await fetch(`${app.url}/api/system/modules`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ id: string; registered: boolean; schemaVersion: number }>;
    assert.equal(body.length, MODULE_IDS.length);
    assert.ok(body.every((m) => m.registered));
    for (const mod of modules) {
      const status = body.find((m) => m.id === mod.id);
      assert.equal(status?.schemaVersion, mod.migrations?.length ?? 0, mod.id);
    }
  } finally {
    await app.close();
  }
});

test("probes answer without an identity", async () => {
  const app = await boot({ user: null });
  try {
    assert.deepEqual(await (await fetch(`${app.url}/healthz`)).json(), { status: "ok", version: "test" });
    assert.equal((await fetch(`${app.url}/livez`)).status, 200);
    assert.equal((await fetch(`${app.url}/api/system/modules`)).status, 401);
  } finally {
    await app.close();
  }
});

test("unknown API paths are a JSON 404", async () => {
  const app = await boot();
  try {
    const res = await fetch(`${app.url}/api/does-not-exist`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Not found." });
  } finally {
    await app.close();
  }
});

test("scheduler status is admin only", async () => {
  const app = await boot({ user: mockViewer });
  try {
    assert.equal((await fetch(`${app.url}/api/system/jobs`)).status, 403);
  } finally {
    await app.close();
  }
});

test("a module that fails to register is reported and the rest still serve", async () => {
  const broken: Module = {
    id: "health",
    milestone: "A",
    register() {
      throw new Error("nope");
    },
  };
  const working: Module = {
    id: "checks",
    milestone: "A",
    register(ctx) {
      ctx.route("GET /api/checks", () => []);
    },
  };
  const app = await boot({ modules: [broken, working] });
  try {
    const status = (await (await fetch(`${app.url}/api/system/modules`)).json()) as Array<{
      id: string;
      error?: string;
    }>;
    assert.equal(status.find((m) => m.id === "health")?.error, "nope");
    assert.deepEqual(await (await fetch(`${app.url}/api/checks`)).json(), []);
  } finally {
    await app.close();
  }
});

test("a module cannot bind another module's routes", async () => {
  const greedy: Module = {
    id: "checks",
    milestone: "A",
    register(ctx) {
      ctx.route("GET /api/hosts", () => []);
    },
  };
  const app = await boot({ modules: [greedy] });
  try {
    const status = (await (await fetch(`${app.url}/api/system/modules`)).json()) as Array<{ error?: string }>;
    assert.match(status[0]!.error ?? "", /cannot bind/);
  } finally {
    await app.close();
  }
});

test("HttpError from a handler becomes its status; anything else a 500", async () => {
  const { HttpError } = await import("../../src/runtime/http.js");
  const mod: Module = {
    id: "hosts",
    milestone: "A",
    register(ctx) {
      ctx.route("GET /api/hosts/:id", (req) => {
        if (req.params.id === "missing") throw new HttpError(404, "No such host.");
        throw new Error("secret detail");
      });
    },
  };
  const app = await boot({ modules: [mod] });
  try {
    const missing = await fetch(`${app.url}/api/hosts/missing`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "No such host." });
    const broken = await fetch(`${app.url}/api/hosts/x`);
    assert.equal(broken.status, 500);
    assert.deepEqual(await broken.json(), { error: "Internal error." });
  } finally {
    await app.close();
  }
});

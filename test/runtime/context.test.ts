import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createMockContext, mockViewer } from "../../src/contracts/mocks/context.js";
import { listen } from "./helpers.js";

test("settings must be declared under the module's own prefix", async () => {
  const mock = createMockContext("checks", { settings: { "checks.defaultTimeoutMs": 2500 } });
  const timeout = mock.ctx.settings.declare({
    key: "checks.defaultTimeoutMs",
    label: "Default timeout",
    schema: z.number().int().positive(),
    default: 10_000,
  });
  assert.equal(timeout.get(), 2500);
  assert.throws(
    () => mock.ctx.settings.declare({ key: "hosts.x", label: "x", schema: z.string(), default: "" }),
    /keys start with "checks\."/
  );
  await mock.close();
});

test("secrets are confined to the module's scope", async () => {
  const mock = createMockContext("hosts");
  await mock.ctx.secrets.put("hosts", "nas", "-----BEGIN KEY-----");
  await mock.ctx.secrets.put("hosts:keys", "box", "pw");
  assert.equal(await mock.ctx.secrets.get("hosts", "nas"), "-----BEGIN KEY-----");
  await assert.rejects(mock.ctx.secrets.get("notify", "discord"), /cannot use secret scope/);
  await mock.close();
});

test("require() answers 403 for an action the caller may not take", async () => {
  const mock = createMockContext("checks", { user: mockViewer });
  mock.ctx.route("POST /api/checks", (req, res) => {
    if (!mock.ctx.require(req, res, "write")) return undefined;
    throw new Error("unreachable");
  });
  mock.ctx.route("GET /api/checks", (req, res) => (mock.ctx.require(req, res, "read") ? [] : undefined));
  const server = await listen(mock.app);
  try {
    assert.equal((await fetch(`${server.url}/api/checks`)).status, 200);
    const denied = await fetch(`${server.url}/api/checks`, { method: "POST" });
    assert.equal(denied.status, 403);
  } finally {
    await server.close();
    await mock.close();
  }
});

test("collectors' samples and audit entries are observable on the mock", async () => {
  const mock = createMockContext("metrics-k8s");
  mock.ctx.metrics.write([{ series: "node.cpu.percent", labels: { node: "n1" }, ts: 1, value: 3 }]);
  mock.ctx.audit.record({ actor: "admin", action: "metrics-k8s.test" });
  assert.equal(mock.samples.length, 1);
  assert.equal(mock.audit[0]!.action, "metrics-k8s.test");
  await mock.close();
});

test("the metrics module can install its own sink on its mock context", async () => {
  const mock = createMockContext("metrics");
  const got: number[] = [];
  mock.ctx.metrics.setSink((batch) => void got.push(batch.length));
  mock.ctx.metrics.write([{ series: "s", labels: {}, ts: 1, value: 1 }]);
  assert.deepEqual(got, [1]);
  assert.equal(mock.samples.length, 0);
  await mock.close();
});

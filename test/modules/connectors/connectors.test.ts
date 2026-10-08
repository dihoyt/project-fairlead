import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type {
  ConnectorKind,
  ConnectorKindView,
  ConnectorRegistry,
  ConnectorRemoveResult,
  ConnectorTestResult,
  ConnectorView,
} from "../../../src/contracts/connectors.js";
import { createMockContext, mockViewer } from "../../../src/contracts/mocks/context.js";
import {
  createFakeConnectorKind,
  createFakeTool,
  FAKE_MARKER,
} from "../../../src/contracts/mocks/connectors/registry.js";
import connectors from "../../../src/modules/connectors/index.js";

async function setup(extraKinds: ConnectorKind[] = []) {
  const m = createMockContext("connectors", { migrations: connectors.migrations ?? [] });
  await connectors.register(m.ctx);
  const registry: ConnectorRegistry = m.ctx.services.get("connectors");
  const tool = createFakeTool();
  registry.addKind(createFakeConnectorKind(tool));
  for (const kind of extraKinds) registry.addKind(kind);
  const server: Server = await new Promise((resolve) => {
    const s = m.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/connectors`;
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T & { error?: string } };
  };
  return {
    m,
    registry,
    tool,
    call,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await m.close();
    },
  };
}

const good = { kind: "fake", name: "Fake", values: { token: "good", zone: "example.test" } };

test("kinds list what each connector asks for", async () => {
  const s = await setup();
  try {
    const { body } = await s.call<ConnectorKindView[]>("GET", "/kinds");
    assert.equal(body.length, 1);
    assert.equal(body[0]!.kind, "fake");
    assert.deepEqual(
      body[0]!.fields.map((f) => [f.key, f.type]),
      [
        ["token", "secret"],
        ["zone", "text"],
      ]
    );
    assert.equal(body[0]!.single, false);
  } finally {
    await s.close();
  }
});

test("create verifies, seals the secret and never returns it", async () => {
  const s = await setup();
  try {
    const { status, body } = await s.call<ConnectorView>("POST", "", good);
    assert.equal(status, 200);
    assert.equal(body.status, "ok");
    assert.deepEqual(body.config, { zone: "example.test" });
    assert.deepEqual(body.secrets, { token: true });
    assert.ok(!JSON.stringify(body).includes('"good"'));
    assert.deepEqual([...s.m.secrets.values()], ["good"]);
    const audit = s.m.audit.find((a) => a.action === "connectors.create");
    assert.ok(audit && !JSON.stringify(audit).includes("good"));

    const instance = await s.registry.instance(body.id);
    assert.deepEqual(instance?.secrets, { token: "good" });
  } finally {
    await s.close();
  }
});

test("a rejected credential is saved with a crit check saying why", async () => {
  const s = await setup();
  try {
    const { body } = await s.call<ConnectorView>("POST", "", { ...good, values: { token: "bad", zone: "z" } });
    assert.equal(body.status, "crit");
    assert.equal(body.checks[0]!.detail, "Token rejected");
    assert.ok(body.checks[0]!.raw);
  } finally {
    await s.close();
  }
});

test("unknown fields, missing required ones and unknown kinds are 400s", async () => {
  const s = await setup();
  try {
    assert.equal((await s.call("POST", "", { ...good, values: { ...good.values, extra: "x" } })).status, 400);
    const missing = await s.call("POST", "", { ...good, values: { zone: "z" } });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error ?? "", /Token is required/);
    assert.equal((await s.call("POST", "", { ...good, kind: "nope" })).status, 400);
  } finally {
    await s.close();
  }
});

test("a single kind refuses a second instance", async () => {
  const single: ConnectorKind = { ...createFakeConnectorKind(createFakeTool()), kind: "solo", single: true };
  const s = await setup([single]);
  try {
    assert.equal((await s.call("POST", "", { ...good, kind: "solo" })).status, 200);
    assert.equal((await s.call("POST", "", { ...good, kind: "solo" })).status, 409);
  } finally {
    await s.close();
  }
});

test("update keeps a secret left out and re-checks", async () => {
  const s = await setup();
  try {
    const { body: created } = await s.call<ConnectorView>("POST", "", good);
    const { body } = await s.call<ConnectorView>("PUT", `/${created.id}`, {
      name: "Renamed",
      values: { zone: "other.test", token: "" },
    });
    assert.equal(body.name, "Renamed");
    assert.equal(body.config.zone, "other.test");
    assert.equal(body.status, "ok");
    assert.deepEqual((await s.registry.instance(created.id))?.secrets, { token: "good" });

    const { body: rotated } = await s.call<ConnectorView>("PUT", `/${created.id}`, { values: { token: "bad" } });
    assert.equal(rotated.status, "crit");
    assert.match(s.m.audit.at(-1)!.detail ?? "", /changed token/);
  } finally {
    await s.close();
  }
});

test("test checks unsaved values, borrowing stored secrets by id", async () => {
  const s = await setup();
  try {
    const fresh = await s.call<ConnectorTestResult>("POST", "/test", {
      kind: "fake",
      values: { token: "bad", zone: "z" },
    });
    assert.equal(fresh.body.ok, false);
    const { body: created } = await s.call<ConnectorView>("POST", "", good);
    const borrowed = await s.call<ConnectorTestResult>("POST", "/test", {
      kind: "fake",
      values: { zone: "z" },
      id: created.id,
    });
    assert.equal(borrowed.body.ok, true);
    assert.equal(Array.isArray((await s.call("GET", "")).body), true);
  } finally {
    await s.close();
  }
});

test("reconcile creates, puts back drift, reports a missing object and leaves an unmarked one alone", async () => {
  const s = await setup();
  try {
    const { body: created } = await s.call<ConnectorView>("POST", "", good);
    s.tool.desired.set("a", "1").set("b", "2");
    s.tool.records.set("x", { id: "x", name: "b", value: "theirs" });

    let { body } = await s.call<ConnectorView>("POST", `/${created.id}/reconcile`);
    assert.deepEqual(
      body.drift!.items.map((i) => [i.key, i.state]),
      [
        ["a", "in-sync"],
        ["b", "conflict-unowned"],
      ]
    );
    assert.equal(s.tool.records.get("x")!.value, "theirs");
    assert.equal(body.status, "warn");
    assert.equal(s.registry.owned(created.id).list().length, 1);

    const mine = [...s.tool.records.values()].find((r) => r.marker === FAKE_MARKER)!;
    mine.value = "changed";
    ({ body } = await s.call<ConnectorView>("POST", `/${created.id}/reconcile`));
    const a = body.drift!.items.find((i) => i.key === "a")!;
    assert.equal(a.state, "drifted");
    assert.deepEqual(a.diff, [{ path: "value", want: "1", have: "changed" }]);
    assert.equal(mine.value, "1");

    s.tool.records.delete(mine.id);
    ({ body } = await s.call<ConnectorView>("POST", `/${created.id}/reconcile`));
    assert.equal(body.drift!.items.find((i) => i.key === "a")!.state, "missing");

    s.tool.down = true;
    ({ body } = await s.call<ConnectorView>("POST", `/${created.id}/reconcile`));
    const check = body.checks.find((c) => c.id === "reconcile")!;
    assert.equal(check.status, "crit");
    assert.match(check.detail, /unreachable/);
  } finally {
    await s.close();
  }
});

test("delete with cleanup removes what the connector made, then the instance and its secrets", async () => {
  const s = await setup();
  try {
    const { body: created } = await s.call<ConnectorView>("POST", "", good);
    s.tool.desired.set("a", "1");
    await s.registry.reconcile(created.id);
    assert.equal(s.tool.records.size, 1);

    const { body } = await s.call<ConnectorRemoveResult>("DELETE", `/${created.id}?cleanup=1`);
    assert.deepEqual(body, { ok: true, removed: 1, errors: [] });
    assert.equal(s.tool.records.size, 0);
    assert.equal(s.m.secrets.size, 0);
    assert.equal((await s.call("GET", `/${created.id}`)).status, 404);
  } finally {
    await s.close();
  }
});

test("only admins change connectors; anyone signed in reads them", async () => {
  const s = await setup();
  try {
    s.m.setUser(mockViewer);
    assert.equal((await s.call("POST", "", good)).status, 403);
    assert.equal((await s.call("POST", "/test", { kind: "fake", values: good.values })).status, 403);
    assert.equal((await s.call("GET", "")).status, 200);
  } finally {
    await s.close();
  }
});

test("each instance is one check on its category tile", async () => {
  const s = await setup();
  try {
    await s.call<ConnectorView>("POST", "", good);
    const provider = s.m.ctx.health.list().find((p) => p.id === "connectors.access")!;
    const results = await provider.collect();
    assert.equal(results.length, 1);
    assert.equal(results[0]!.status, "ok");
    assert.equal(results[0]!.label, "Fake tool: Fake");
    const identity = s.m.ctx.health.list().find((p) => p.id === "connectors.identity")!;
    assert.deepEqual(await identity.collect(), []);
  } finally {
    await s.close();
  }
});

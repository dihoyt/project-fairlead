import { test } from "node:test";
import assert from "node:assert/strict";
import type { Events } from "../../../src/contracts/events.js";
import type { CheckResult, HealthProvider } from "../../../src/contracts/health.js";
import type { ModuleContext } from "../../../src/contracts/module.js";
import { createMockContext, mockViewer } from "../../../src/contracts/mocks/context.js";
import { createMockHealthProvider, mockCheckResults, withStatus } from "../../../src/contracts/mocks/health.js";
import { createEventBus } from "../../../src/runtime/bus.js";
import { silentLogger } from "../../../src/runtime/log.js";
import { createHealthRegistry } from "../../../src/runtime/registries.js";
import { createScheduler } from "../../../src/runtime/scheduler.js";
import mod from "../../../src/modules/health/index.js";
import { migrations } from "../../../src/modules/health/migrations.js";
import { createLease } from "../../../src/modules/health/lease.js";
import { startHealth, type HealthOptions } from "../../../src/modules/health/service.js";
import { listen } from "../../runtime/helpers.js";

type Change = Events["health.changed"];

const settle = () => new Promise((resolve) => setImmediate(resolve));

// Another pod holds the scheduling lease, so scheduled runs in these tests
// are no-ops and only the runs a test forces happen.
function leaseElsewhere(ctx: ModuleContext) {
  ctx.db
    .prepare(
      "INSERT INTO health_leases (org_id, name, holder, expires_at) VALUES (?, 'health.scheduler', 'elsewhere', ?)"
    )
    .run(ctx.orgId, Date.now() + 3_600_000);
}

function setup(options: HealthOptions & { settings?: Record<string, unknown> } = {}) {
  const mock = createMockContext("health", { migrations, settings: options.settings });
  leaseElsewhere(mock.ctx);
  const health = startHealth(mock.ctx, options);
  const events: Change[] = [];
  mock.ctx.bus.on("health.changed", (change) => void events.push(change));
  return { ...mock, health, events };
}

const ok = mockCheckResults.ok;

test("the board renders with no providers", async () => {
  const { health, close } = setup();
  const board = health.board();
  assert.deepEqual(
    board.tiles.map((t) => [t.category, t.status]),
    ["cluster", "storage", "backups", "gitops", "hosts", "checks"].map((c) => [c, "absent"])
  );
  assert.equal(board.status, "absent");
  assert.equal(health.category("cluster").providers.length, 0);
  await close();
});

test("a provider drives its tile ok → warn → crit → ok with one event per change and history kept", async () => {
  const { ctx, health, events, close } = setup();
  const provider = createMockHealthProvider("cluster", "cluster", [ok]);
  ctx.health.addProvider(provider);

  const tile = () => health.board().tiles.find((t) => t.category === "cluster")!;
  assert.equal(tile().status, "unknown", "registered but not yet run");

  for (const status of ["ok", "ok", "warn", "warn", "crit", "ok"] as const) {
    provider.set([withStatus(ok, status, `nodes are ${status}`)]);
    await health.run("cluster", { force: true });
    assert.equal(tile().status, status);
  }
  await settle();

  assert.deepEqual(
    events.map((e) => `${e.from}>${e.to}`),
    ["ok>warn", "warn>crit", "crit>ok"]
  );
  assert.equal(tile().summary, "All 1 check OK");
  assert.deepEqual(
    health.history("cluster", ok.id).points.map((p) => p.status),
    ["ok", "warn", "crit", "ok"]
  );
  await close();
});

test("a failing check is the tile's summary and carries its provider", async () => {
  const { ctx, health, close } = setup();
  ctx.health.addProvider(
    createMockHealthProvider("cluster", "cluster", [ok, mockCheckResults.warn, mockCheckResults.crit])
  );
  await health.run("cluster", { force: true });
  const tile = health.board().tiles.find((t) => t.category === "cluster")!;
  assert.equal(tile.status, "crit");
  assert.equal(tile.worst?.providerId, "cluster");
  assert.equal(tile.worst?.id, mockCheckResults.crit.id);
  assert.match(tile.summary, /CrashLoopBackOff/);
  assert.deepEqual(tile.counts, { ok: 1, warn: 1, crit: 1, unknown: 0, absent: 0 });
  assert.deepEqual(health.category("cluster").providers[0]!.results[2]!.raw, mockCheckResults.crit.raw);
  await close();
});

test("a check first seen healthy announces nothing; first seen failing announces once", async () => {
  const { ctx, health, events, close } = setup();
  ctx.health.addProvider(createMockHealthProvider("a", "cluster", [ok]));
  ctx.health.addProvider(createMockHealthProvider("b", "storage", [mockCheckResults.crit, mockCheckResults.absent]));
  await health.run("a", { force: true });
  await health.run("b", { force: true });
  await health.run("b", { force: true });
  await settle();
  assert.deepEqual(
    events.map((e) => [e.providerId, e.checkId, e.to]),
    [["b", mockCheckResults.crit.id, "crit"]]
  );
  await close();
});

test("a throwing provider turns its checks unknown and records the error", async () => {
  const { ctx, health, events, close } = setup();
  const provider = createMockHealthProvider("flaky", "hosts", [ok]);
  ctx.health.addProvider(provider);
  await health.run("flaky", { force: true });

  provider.collect = async () => {
    throw new Error("connect ETIMEDOUT");
  };
  await health.run("flaky", { force: true });
  await settle();

  const state = health.category("hosts").providers[0]!;
  assert.equal(state.status, "unknown");
  assert.equal(state.lastError, "connect ETIMEDOUT");
  assert.match(state.results[0]!.detail, /ETIMEDOUT/);
  assert.deepEqual(state.results[0]!.raw, { error: "connect ETIMEDOUT" });
  assert.deepEqual(
    events.map((e) => `${e.from}>${e.to}`),
    ["ok>unknown"]
  );
  await close();
});

test("malformed results are treated as a failure, not stored", async () => {
  const { ctx, health, close } = setup();
  const bad: HealthProvider = {
    id: "bad",
    category: "checks",
    label: "Bad",
    intervalMs: 30_000,
    collect: async () => [{ id: "x", status: "purple" }] as unknown as CheckResult[],
  };
  ctx.health.addProvider(bad);
  await health.run("bad", { force: true });
  const state = health.category("checks").providers[0]!;
  assert.equal(state.status, "unknown");
  assert.match(state.lastError ?? "", /malformed/);
  assert.equal(state.results[0]!.id, "collect");
  await close();
});

test("a check that disappears goes absent with an event", async () => {
  const { ctx, health, events, close } = setup();
  const provider = createMockHealthProvider("p", "cluster", [ok, mockCheckResults.crit]);
  ctx.health.addProvider(provider);
  await health.run("p", { force: true });
  provider.set([ok]);
  await health.run("p", { force: true });
  await settle();
  assert.deepEqual(
    events.map((e) => `${e.checkId}:${e.from}>${e.to}`),
    [`${mockCheckResults.crit.id}:ok>crit`, `${mockCheckResults.crit.id}:crit>absent`]
  );
  assert.deepEqual(
    health.category("cluster").providers[0]!.results.map((r) => r.id),
    [ok.id]
  );
  await close();
});

test("rules from settings override thresholds, cap severity and disable checks", async () => {
  const { ctx, health, close } = setup({
    settings: {
      "health.rules": {
        "p/nodes.ready": { warnBelow: 4, critBelow: 2 },
        "p/pods.crashloop": { maxStatus: "warn" },
        "p/certs.expiry": { disabled: true },
      },
    },
  });
  ctx.health.addProvider(createMockHealthProvider("p", "cluster", [ok, mockCheckResults.crit, mockCheckResults.warn]));
  await health.run("p", { force: true });
  const byId = Object.fromEntries(health.category("cluster").providers[0]!.results.map((r) => [r.id, r.status]));
  assert.deepEqual(byId, { "nodes.ready": "warn", "pods.crashloop": "warn", "certs.expiry": "absent" });
  await close();
});

test("a provider that stops reporting reads as stale/unknown", async () => {
  let clock = Date.now();
  const { ctx, health, close } = setup({ now: () => clock });
  ctx.health.addProvider(createMockHealthProvider("p", "gitops", [ok], 30_000));
  await health.run("p", { force: true });
  assert.equal(health.board().tiles.find((t) => t.category === "gitops")!.status, "ok");
  clock += 10 * 60_000;
  const state = health.category("gitops").providers[0]!;
  assert.equal(state.status, "unknown");
  assert.match(state.lastError ?? "", /No result since/);
  await close();
});

test("history honours from/to, includes the state the window opened in, and prunes", async () => {
  let clock = Date.parse("2026-10-01T00:00:00Z");
  const { ctx, health, close } = setup({ now: () => clock, settings: { "health.historyDays": 2 } });
  const provider = createMockHealthProvider("p", "cluster", [ok]);
  ctx.health.addProvider(provider);
  for (const status of ["ok", "warn", "ok"] as const) {
    provider.set([withStatus(ok, status)]);
    await health.run("p", { force: true });
    clock += 86_400_000;
  }
  const window = health.history("p", ok.id, "2026-10-01T12:00:00.000Z", "2026-10-03T00:00:00.000Z");
  assert.deepEqual(
    window.points.map((p) => [p.at, p.status]),
    [
      ["2026-10-01T12:00:00.000Z", "ok"],
      ["2026-10-02T00:00:00.000Z", "warn"],
      ["2026-10-03T00:00:00.000Z", "ok"],
    ]
  );
  assert.equal(health.prune(), 1);
  assert.equal(health.history("p", ok.id, "2026-09-01T00:00:00.000Z", "2026-10-04T00:00:00.000Z").points.length, 2);
  await close();
});

test("the lease goes to one holder and passes on when it lapses", async () => {
  const { ctx, close } = createMockContext("health", { migrations });
  let clock = 1_000_000;
  const a = createLease(ctx.db, ctx.orgId, "x", "pod-a", 30_000, () => clock);
  const b = createLease(ctx.db, ctx.orgId, "x", "pod-b", 30_000, () => clock);
  assert.equal(a.acquire(), true);
  assert.equal(b.acquire(), false);
  clock += 20_000;
  assert.equal(a.acquire(), true, "renewal");
  clock += 40_000;
  assert.equal(a.held(), false);
  assert.equal(b.acquire(), true, "takeover after lapse");
  assert.equal(a.acquire(), false);
  await close();
});

test("two pods on one database: only the lease holder collects, and a change is emitted once", async () => {
  const mock = createMockContext("health", { migrations });
  const schedulerB = createScheduler(silentLogger);
  const ctxB: ModuleContext = {
    ...mock.ctx,
    bus: createEventBus<Events>(silentLogger),
    health: createHealthRegistry(silentLogger),
    scheduler: schedulerB.forModule("health"),
  };
  const podA = startHealth(mock.ctx, { holder: "pod-a" });
  const podB = startHealth(ctxB, { holder: "pod-b" });
  assert.equal(podA.lease.held(), true);
  assert.equal(podB.lease.held(), false);

  const events: string[] = [];
  mock.ctx.bus.on("health.changed", (e) => void events.push(`a:${e.to}`));
  ctxB.bus.on("health.changed", (e) => void events.push(`b:${e.to}`));
  const providerA = createMockHealthProvider("p", "cluster", [ok]);
  const providerB = createMockHealthProvider("p", "cluster", [ok]);
  mock.ctx.health.addProvider(providerA);
  ctxB.health.addProvider(providerB);

  assert.equal(await podB.run("p"), null, "a scheduled run on the follower is skipped");
  assert.equal(providerB.calls, 0);

  providerA.set([mockCheckResults.crit]);
  providerB.set([mockCheckResults.crit]);
  await Promise.all([podA.run("p", { force: true }), podB.run("p", { force: true })]);
  await settle();
  assert.equal(events.length, 1, `one event across pods, got ${events.join(", ")}`);

  await schedulerB.stopAll();
  await mock.close();
});

test("HTTP routes: board, category, history, run", async () => {
  const mock = createMockContext("health", {
    migrations,
    settings: { "health.links": { cluster: [{ label: "Rancher", url: "https://rancher.example.test" }] } },
  });
  leaseElsewhere(mock.ctx);
  await mod.register(mock.ctx);
  mock.ctx.health.addProvider(createMockHealthProvider("cluster", "cluster", [mockCheckResults.warn]));
  const server = await listen(mock.app);
  const get = (path: string) => fetch(`${server.url}${path}`);
  const post = (path: string) => fetch(`${server.url}${path}`, { method: "POST" });
  try {
    const run = await post("/api/health/providers/cluster/run");
    assert.equal(run.status, 200);
    assert.equal(((await run.json()) as CheckResult[])[0]!.status, "warn");
    assert.deepEqual(mock.audit, [{ actor: "admin", action: "health.run", target: "cluster" }]);

    const board = (await (await get("/api/health/board")).json()) as { status: string };
    assert.equal(board.status, "warn");

    const detail = (await (await get("/api/health/categories/cluster")).json()) as { links: unknown[] };
    assert.deepEqual(detail.links, [{ label: "Rancher", url: "https://rancher.example.test" }]);
    assert.equal((await get("/api/health/categories/nope")).status, 404);

    const history = (await (await get(`/api/health/history/cluster/${mockCheckResults.warn.id}`)).json()) as {
      points: unknown[];
    };
    assert.equal(history.points.length, 1);
    assert.equal((await get("/api/health/history/cluster/x?from=yesterday")).status, 400);

    assert.equal((await post("/api/health/providers/missing/run")).status, 404);
    mock.setUser(mockViewer);
    assert.equal((await post("/api/health/providers/cluster/run")).status, 403);
  } finally {
    await server.close();
    await mock.close();
  }
});

test("a check's object survives the store and a malformed one is a failure", async () => {
  const { ctx, health, close } = setup();
  const object = { kind: "Pod", namespace: "media", name: "jellyfin-7c9d8" };
  const provider = createMockHealthProvider("p", "cluster", [{ ...mockCheckResults.crit, object }]);
  ctx.health.addProvider(provider);
  await health.run("p", { force: true });
  assert.deepEqual(health.category("cluster").providers[0]!.results[0]!.object, object);

  provider.set([{ ...ok, object: { kind: "Pod" } as unknown as typeof object }]);
  await health.run("p", { force: true });
  assert.match(health.category("cluster").providers[0]!.lastError ?? "", /malformed/);
  await close();
});

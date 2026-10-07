import { test } from "node:test";
import assert from "node:assert/strict";
import { mockSamples } from "../../../src/contracts/mocks/metrics.js";
import { DAY, HOUR, MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import type { Sample } from "../../../src/contracts/metrics.js";
import { migrations } from "../../../src/modules/metrics/migrations.js";
import { createMetricsStore } from "../../../src/modules/metrics/store.js";
import { openDatabase } from "../../../src/runtime/db.js";
import { applyMigrations, DEFAULT_ORG_ID, runtimeMigrations } from "../../../src/runtime/migrations.js";

const STEP = 15_000;
const MIN5 = 300_000;

function setup(start = MOCK_NOW) {
  const db = openDatabase(":memory:");
  applyMigrations(db, "runtime", runtimeMigrations);
  applyMigrations(db, "metrics", migrations);
  const clock = { now: start };
  const store = createMetricsStore(db, { orgId: DEFAULT_ORG_ID, now: () => clock.now });
  return { db, clock, store };
}

const count = (db: ReturnType<typeof setup>["db"], table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

// 24h of 15s samples for nodes, containers and hosts, ending at MOCK_NOW.
function day(): Sample[] {
  const from = MOCK_NOW - DAY + STEP;
  return [
    ...["node-1", "node-2", "node-3"].flatMap((node) => [
      ...mockSamples("node.cpu.percent", { node }, from, MOCK_NOW),
      ...mockSamples("node.memory.percent", { node }, from, MOCK_NOW),
    ]),
    ...mockSamples("container.memory.bytes", { namespace: "apps", pod: "web-0", container: "web" }, from, MOCK_NOW),
    ...mockSamples("host.cpu.percent", { host: "nas" }, from, MOCK_NOW),
    ...mockSamples("host.temp.celsius", { host: "nas", sensor: "cpu" }, from, MOCK_NOW),
  ];
}

test("24h of 15s samples downsample into exact 5-minute and hourly averages", () => {
  const { db, store } = setup();
  const samples = day();
  assert.equal(store.write(samples).stored, samples.length);
  assert.equal(count(db, "metrics_raw"), samples.length);

  const cpu = samples.filter((s) => s.series === "host.cpu.percent");
  const expect = (width: number) => {
    const buckets = new Map<number, number[]>();
    for (const s of cpu) buckets.set(s.ts - (s.ts % width), [...(buckets.get(s.ts - (s.ts % width)) ?? []), s.value]);
    return buckets;
  };
  for (const [table, width] of [
    ["metrics_5m", MIN5],
    ["metrics_1h", HOUR],
  ] as const) {
    const rows = db
      .prepare(
        `SELECT r.ts, r.count, r.sum, r.min, r.max FROM ${table} r JOIN metrics_series s ON s.id = r.series_id
         WHERE s.series = 'host.cpu.percent' ORDER BY r.ts`
      )
      .all() as { ts: number; count: number; sum: number; min: number; max: number }[];
    const buckets = expect(width);
    assert.equal(rows.length, buckets.size);
    for (const row of rows) {
      const values = buckets.get(row.ts)!;
      assert.equal(row.count, values.length);
      assert.ok(Math.abs(row.sum - values.reduce((a, b) => a + b, 0)) < 1e-6);
      assert.equal(row.min, Math.min(...values));
      assert.equal(row.max, Math.max(...values));
    }
    // Full buckets hold exactly width/15s samples.
    assert.ok(rows.slice(1, -1).every((row) => row.count === width / STEP));
  }
});

test("a sample written twice is stored and rolled up once", () => {
  const { db, store } = setup();
  const sample = { series: "node.cpu.percent", labels: { node: "a" }, ts: MOCK_NOW - 1000, value: 10 };
  store.write([sample]);
  assert.deepEqual(store.write([sample, { ...sample, labels: { node: "a" } }]), { stored: 0, dropped: 2 });
  assert.equal((db.prepare("SELECT count FROM metrics_5m").get() as { count: number }).count, 1);
});

test("label order does not split a series", () => {
  const { db, store } = setup();
  store.write([
    { series: "container.cpu.percent", labels: { pod: "p", container: "c" }, ts: MOCK_NOW - 2000, value: 1 },
    { series: "container.cpu.percent", labels: { container: "c", pod: "p" }, ts: MOCK_NOW - 1000, value: 2 },
  ]);
  assert.equal(count(db, "metrics_series"), 1);
});

test("invalid, stale and far-future samples are dropped", () => {
  const { store } = setup();
  const ok: Sample = { series: "host.disk.percent", labels: { host: "h" }, ts: MOCK_NOW, value: 1 };
  const result = store.write([
    ok,
    { ...ok, value: Number.NaN },
    { ...ok, series: "Bad Name" },
    { ...ok, series: "nodot" },
    { ...ok, labels: { host: 1 as unknown as string } },
    { ...ok, ts: MOCK_NOW - DAY - 1 },
    { ...ok, ts: MOCK_NOW + 2 * HOUR },
    null as unknown as Sample,
  ]);
  assert.deepEqual(result, { stored: 1, dropped: 7 });
});

test("the planner picks raw for 1h, 5-minute rollups for 24h and 7d, hourly for 30d", () => {
  const { store } = setup();
  const plan = (span: number, stepMs?: number) => {
    const { tier, stepMs: step } = store.plan({ from: MOCK_NOW - span, to: MOCK_NOW, stepMs });
    return [tier.table, step];
  };
  assert.deepEqual(plan(HOUR), ["metrics_raw", 12_500]);
  assert.deepEqual(plan(DAY), ["metrics_5m", MIN5]);
  assert.deepEqual(plan(7 * DAY)[0], "metrics_5m");
  assert.deepEqual(plan(30 * DAY)[0], "metrics_1h");
  // A fine step over a range raw no longer covers falls back to the finest
  // tier that does, at that tier's resolution.
  assert.deepEqual(plan(2 * DAY, 15_000), ["metrics_5m", MIN5]);
  assert.deepEqual(plan(60 * DAY, 15_000), ["metrics_1h", HOUR]);
  // No result is allowed more than MAX_POINTS points.
  assert.deepEqual(plan(DAY, 1), ["metrics_raw", 17_280]);
});

test("queries fan out by label set, filter by labels, and bucket by step", () => {
  const { store } = setup();
  store.write(day());
  const all = store.query({ series: "node.cpu.percent", from: MOCK_NOW - HOUR, to: MOCK_NOW, stepMs: 60_000 });
  assert.deepEqual(
    all.map((r) => r.labels.node),
    ["node-1", "node-2", "node-3"]
  );
  assert.equal(all[0]!.points.length, 61);
  for (const [ts] of all[0]!.points) assert.equal(ts % 60_000, 0);

  const one = store.query({
    series: "node.cpu.percent",
    labels: { node: "node-2" },
    from: MOCK_NOW - HOUR,
    to: MOCK_NOW,
    stepMs: 60_000,
  });
  assert.equal(one.length, 1);
  assert.deepEqual(one[0]!.points, all[1]!.points);

  // The average of a minute's four raw samples.
  const minute = MOCK_NOW - 30 * 60_000;
  const raw = mockSamples("node.cpu.percent", { node: "node-2" }, minute, minute + 59_999);
  const point = one[0]!.points.find(([ts]) => ts === minute)!;
  assert.ok(Math.abs(point[1] - raw.reduce((a, s) => a + s.value, 0) / raw.length) < 1e-9);

  assert.deepEqual(store.query({ series: "node.cpu.percent", labels: { node: "nope" }, from: 0, to: MOCK_NOW }), []);
  assert.deepEqual(store.query({ series: "never.written", from: 0, to: MOCK_NOW }), []);

  const hosts = store.query({ series: "host.temp.celsius", from: MOCK_NOW - DAY, to: MOCK_NOW });
  assert.deepEqual(hosts[0]!.labels, { host: "nas", sensor: "cpu" });
  assert.equal(hosts[0]!.points.length, 289);
});

test("1h, 24h and 7d queries answer in under 100ms over a day of 15s samples", () => {
  const { store } = setup();
  store.write(day());
  for (const span of [HOUR, DAY, 7 * DAY]) {
    const started = performance.now();
    const results = ["node.cpu.percent", "node.memory.percent", "host.cpu.percent"].flatMap((series) =>
      store.query({ series, from: MOCK_NOW - span, to: MOCK_NOW })
    );
    const took = performance.now() - started;
    assert.equal(results.length, 7);
    assert.ok(took < 100, `${span / HOUR}h query took ${took.toFixed(1)}ms`);
  }
});

test("series listing groups label sets and honours the prefix literally", () => {
  const { store } = setup();
  store.write(day());
  store.write([{ series: "node_x.cpu.percent", labels: {}, ts: MOCK_NOW, value: 1 }]);
  const nodes = store.listSeries("node.");
  assert.deepEqual(
    nodes.map((s) => s.series),
    ["node.cpu.percent", "node.memory.percent"]
  );
  assert.deepEqual(nodes[0], {
    series: "node.cpu.percent",
    labelKeys: ["node"],
    firstTs: MOCK_NOW - DAY + STEP,
    lastTs: MOCK_NOW,
  });
  assert.deepEqual(store.listSeries("host.").find((s) => s.series === "host.temp.celsius")?.labelKeys, [
    "host",
    "sensor",
  ]);
  assert.equal(store.listSeries().length, 6);
  assert.deepEqual(store.listSeries("node_"), [
    { series: "node_x.cpu.percent", labelKeys: [], firstTs: MOCK_NOW, lastTs: MOCK_NOW },
  ]);
});

test("retention trims each tier to its window and forgets empty series", () => {
  const { db, clock, store } = setup();
  store.write(day());
  const raw = count(db, "metrics_raw");

  clock.now = MOCK_NOW + 12 * HOUR;
  store.applyRetention();
  assert.ok(count(db, "metrics_raw") < raw);
  assert.equal((db.prepare("SELECT MIN(ts) AS t FROM metrics_raw").get() as { t: number }).t, MOCK_NOW - 12 * HOUR);

  clock.now = MOCK_NOW + 2 * DAY;
  store.applyRetention();
  assert.equal(count(db, "metrics_raw"), 0);
  assert.ok(count(db, "metrics_5m") > 0);
  // Older than raw keeps, so the rollups answer it.
  const fromRollups = store.query({ series: "host.cpu.percent", from: MOCK_NOW - DAY, to: MOCK_NOW });
  assert.equal(fromRollups[0]!.points.length, 289);

  clock.now = MOCK_NOW + 31 * DAY;
  store.applyRetention();
  assert.equal(count(db, "metrics_5m"), 0);
  assert.ok(count(db, "metrics_1h") > 0);

  clock.now = MOCK_NOW + 367 * DAY;
  store.applyRetention();
  assert.equal(count(db, "metrics_1h"), 0);
  // The newest series row outlives its data so its id is never handed out again.
  assert.equal(count(db, "metrics_series"), 1);
  assert.deepEqual(store.listSeries(), []);

  // A series that comes back after being forgotten gets a fresh id.
  const before = (db.prepare("SELECT MAX(id) AS id FROM metrics_series").get() as { id: number }).id;
  store.write([{ series: "host.cpu.percent", labels: { host: "nas" }, ts: clock.now, value: 3 }]);
  const after = db.prepare("SELECT id FROM metrics_series WHERE series = 'host.cpu.percent'").get() as { id: number };
  assert.ok(after.id > before);
  assert.equal(store.query({ series: "host.cpu.percent", from: clock.now - HOUR, to: clock.now }).length, 1);
});

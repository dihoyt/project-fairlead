import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createMockContext } from "../../../src/contracts/mocks/context.js";
import { createMockCollector } from "../../../src/contracts/mocks/metrics.js";
import type { SeriesInfo, SeriesResult } from "../../../src/contracts/metrics.js";
import metrics from "../../../src/modules/metrics/index.js";
import { listen } from "../../runtime/helpers.js";

async function boot() {
  const mock = createMockContext("metrics", { migrations: metrics.migrations });
  await metrics.register(mock.ctx);
  const server = await listen(mock.app);
  return {
    ...mock,
    url: server.url,
    get: (path: string) => fetch(`${server.url}/api/metrics${path}`),
    async close() {
      await server.close();
      await mock.close();
    },
  };
}

const q = (queries: unknown) => `/query?q=${encodeURIComponent(JSON.stringify(queries))}`;

async function until<T>(probe: () => Promise<T | undefined>, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await delay(50);
  }
}

test("collectors run on the scheduler and their samples are queryable", async () => {
  const app = await boot();
  try {
    app.ctx.metrics.addCollector(createMockCollector("fake-nodes", "node.cpu.percent", 1000));
    const now = Date.now();
    const results = await until(async () => {
      const res = await app.get(q([{ series: "node.cpu.percent", from: now - 60_000, to: Date.now() + 1000 }]));
      const body = (await res.json()) as SeriesResult[];
      return body.length === 3 ? body : undefined;
    });
    assert.deepEqual(
      results.map((r) => r.labels),
      [{ node: "node-1" }, { node: "node-2" }, { node: "node-3" }]
    );
    assert.ok(results.every((r) => r.points.length >= 1));
    const job = app.ctx.scheduler.list().find((j) => j.name === "collect:fake-nodes");
    assert.equal(job?.intervalMs, 5000, "a collector's interval is floored");
    assert.ok(app.ctx.scheduler.list().some((j) => j.name === "retention"));
  } finally {
    await app.close();
  }
});

test("pushed host samples, including ones written before the module loaded, reach the store", async () => {
  const mock = createMockContext("metrics", { migrations: metrics.migrations });
  const ts = Date.now() - 1000;
  mock.ctx.metrics.write([{ series: "host.disk.percent", labels: { host: "nas", mount: "/volume1" }, ts, value: 71 }]);
  await metrics.register(mock.ctx);
  mock.ctx.metrics.write([{ series: "host.cpu.percent", labels: { host: "nas" }, ts, value: 12.5 }]);
  const server = await listen(mock.app);
  try {
    const res = await fetch(
      `${server.url}/api/metrics${q([
        { series: "host.cpu.percent", labels: { host: "nas" }, from: ts - 1000, to: ts + 1000, stepMs: 1000 },
        { series: "host.disk.percent", from: ts - 1000, to: ts + 1000, stepMs: 1000 },
      ])}`
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as SeriesResult[];
    assert.deepEqual(
      body.map((r) => [r.series, r.points.map(([, v]) => v)]),
      [
        ["host.cpu.percent", [12.5]],
        ["host.disk.percent", [71]],
      ]
    );

    const series = (await (await fetch(`${server.url}/api/metrics/series?prefix=host.`)).json()) as SeriesInfo[];
    assert.deepEqual(
      series.map((s) => [s.series, s.labelKeys]),
      [
        ["host.cpu.percent", ["host"]],
        ["host.disk.percent", ["host", "mount"]],
      ]
    );
  } finally {
    await server.close();
    await mock.close();
  }
});

test("a malformed q is a 400 with the reason", async () => {
  const app = await boot();
  try {
    const cases: [string, RegExp][] = [
      ["/query", /q must be/],
      ["/query?q=nope", /not valid JSON/],
      [q([]), /Invalid q/],
      [q({ series: "a.b", from: 0, to: 1 }), /Invalid q/],
      [q([{ series: "a.b", from: 2, to: 1 }]), /from must not be after to/],
      [q([{ series: "a.b", from: 0, to: 500 * 86_400_000 }]), /400 days/],
      [q([{ series: "a.b", from: 0, to: 1, labels: { a: 1 } }]), /Invalid q/],
      [q(Array.from({ length: 51 }, () => ({ series: "a.b", from: 0, to: 1 }))), /Invalid q/],
    ];
    for (const [path, error] of cases) {
      const res = await app.get(path);
      assert.equal(res.status, 400, path);
      assert.match(((await res.json()) as { error: string }).error, error, path);
    }
  } finally {
    await app.close();
  }
});

test("an empty store answers both routes with empty lists", async () => {
  const app = await boot();
  try {
    assert.deepEqual(
      await (await app.get(q([{ series: "node.cpu.percent", from: Date.now() - 86_400_000, to: Date.now() }]))).json(),
      []
    );
    assert.deepEqual(await (await app.get("/series")).json(), []);
  } finally {
    await app.close();
  }
});

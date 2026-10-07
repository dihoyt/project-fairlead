import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { createEventBus } from "../../src/runtime/bus.js";
import { silentLogger } from "../../src/runtime/log.js";
import {
  createBackupsRegistry,
  createHealthRegistry,
  createMetricsRegistry,
  PENDING_SAMPLE_LIMIT,
} from "../../src/runtime/registries.js";
import { createServiceRegistry } from "../../src/runtime/services.js";
import { createMockHealthProvider } from "../../src/contracts/mocks/health.js";
import { mockLonghornSource, mockCapacitySource } from "../../src/contracts/mocks/backups.js";
import { createFakeK8s } from "../../src/contracts/mocks/k8s.js";
import type { Sample } from "../../src/contracts/metrics.js";

test("a health consumer sees providers added before and after it subscribed", () => {
  const registry = createHealthRegistry(silentLogger);
  registry.addProvider(createMockHealthProvider("early", "cluster"));
  const seen: string[] = [];
  registry.subscribe((p) => seen.push(p.id));
  registry.addProvider(createMockHealthProvider("late", "storage"));
  assert.deepEqual(seen, ["early", "late"]);
  assert.equal(registry.list().length, 2);
});

test("duplicate provider ids are refused", () => {
  const registry = createHealthRegistry(silentLogger);
  registry.addProvider(createMockHealthProvider("x", "cluster"));
  assert.throws(() => registry.addProvider(createMockHealthProvider("x", "cluster")), /already registered/);
});

test("metrics written before a sink exists are handed over when it does", () => {
  const registry = createMetricsRegistry(silentLogger);
  const sample: Sample = { series: "node.cpu.percent", labels: { node: "n1" }, ts: 1, value: 5 };
  registry.write([sample, sample]);
  const received: Sample[] = [];
  registry.setSink((batch) => received.push(...batch));
  assert.equal(received.length, 2);
  registry.write([sample]);
  assert.equal(received.length, 3);
  assert.throws(() => registry.setSink(() => {}), /already installed/);
});

test("held samples are bounded", () => {
  const registry = createMetricsRegistry(silentLogger);
  const sample: Sample = { series: "s", labels: {}, ts: 1, value: 1 };
  registry.write(Array.from({ length: PENDING_SAMPLE_LIMIT + 10 }, () => sample));
  let count = 0;
  registry.setSink((batch) => (count += batch.length));
  assert.equal(count, PENDING_SAMPLE_LIMIT);
});

test("backups registry replays sources and capacities", () => {
  const registry = createBackupsRegistry(silentLogger);
  registry.addSource(mockLonghornSource);
  const seen: string[] = [];
  registry.subscribe({ onSource: (s) => seen.push(s.id), onCapacity: (c) => seen.push(c.id) });
  registry.addCapacity(mockCapacitySource);
  assert.deepEqual(seen, ["longhorn", mockCapacitySource.id]);
});

test("event handlers run after emit and one failing handler doesn't stop the rest", async () => {
  const bus = createEventBus(silentLogger);
  const got: string[] = [];
  bus.on("health.changed", () => {
    throw new Error("bad handler");
  });
  bus.on("health.changed", (e) => void got.push(e.checkId));
  bus.emit("health.changed", { providerId: "p", checkId: "c", label: "C", from: "ok", to: "crit", detail: "" });
  assert.deepEqual(got, [], "delivery is deferred");
  await tick();
  assert.deepEqual(got, ["c"]);
});

test("services: provide once, get anywhere, missing is a clear error", () => {
  const services = createServiceRegistry();
  assert.throws(() => services.get("k8s"), /has not been provided/);
  services.provide("k8s", createFakeK8s());
  assert.equal(services.has("k8s"), true);
  assert.throws(() => services.provide("k8s", createFakeK8s()), /already provided/);
});

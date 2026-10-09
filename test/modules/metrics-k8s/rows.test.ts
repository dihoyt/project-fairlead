import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { HostView } from "../../../src/contracts/hosts.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import {
  NODE_SPARK_POINTS,
  NODE_SPARK_WINDOW_MS,
  type NodeSummary,
  type SeriesQuery,
  type SeriesResult,
} from "../../../src/contracts/metrics.js";
import { mockHost } from "../../../src/contracts/mocks/api.js";
import { createMockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s } from "../../../src/contracts/mocks/k8s.js";
import type { MetricsQuery } from "../../../src/contracts/runtime.js";
import { createK8sService, type K8sService } from "../../../src/modules/k8s/api.js";
import { registerMetricsK8s } from "../../../src/modules/metrics-k8s/index.js";
import { toNodeRows } from "../../../src/modules/metrics-k8s/rows.js";
import { createScraper } from "../../../src/modules/metrics-k8s/scrape.js";
import { loadFixtureSet, startFakeApi, type FakeApi } from "../../support/index.js";
import { listen } from "../../runtime/helpers.js";

const STEP = NODE_SPARK_WINDOW_MS / NODE_SPARK_POINTS;
// On a bucket boundary plus a little, as a real clock would be.
const NOW = Date.parse("2026-10-07T12:00:00.000Z") + 20_000;

let api: FakeApi;
let k8s: K8sService;
before(async () => {
  api = await startFakeApi({ fixtures: loadFixtureSet("synthetic") });
  const conn = { source: "kubeconfig" as const, server: api.url, context: "fake", kubeConfig: api.kubeConfig() };
  k8s = createK8sService({
    connection: () => conn,
    timing: { watchSeconds: [30, 30], backoffMs: [20, 100] },
  });
});
after(async () => {
  await k8s.close();
  await api.close();
});

const host = (id: string, address: string, extra: Partial<HostView> = {}): HostView => ({
  ...mockHost,
  id,
  address,
  ...extra,
});

// Answers every query from fixed points, filtered by labels like the store.
function fakeMetrics(results: SeriesResult[]): MetricsQuery & { queries: SeriesQuery[] } {
  const queries: SeriesQuery[] = [];
  return {
    queries,
    query(q) {
      queries.push(q);
      return results.filter((r) => r.series === q.series);
    },
  };
}

const lastBucket = NOW - (NOW % STEP);
const firstBucket = lastBucket - (NODE_SPARK_POINTS - 1) * STEP;

test("the nodes route adds role, state, versions, capacity and Longhorn space from the cluster", async () => {
  const mock = createMockContext("metrics-k8s", {
    services: { k8s },
    calls: { "GET /api/hosts": () => [] },
  });
  registerMetricsK8s(mock.ctx, { now: () => NOW });
  const server = await listen(mock.app);
  try {
    const res = await fetch(`${server.url}/api/metrics-k8s/nodes`);
    assert.equal(res.status, 200);
    const [cp, w1, w2] = (await res.json()) as NodeSummary[];

    assert.deepEqual(cp!.roles, ["control-plane"]);
    assert.deepEqual(w1!.roles, ["worker"]);
    assert.equal(cp!.schedulable, true);
    assert.deepEqual(cp!.pressure, []);
    assert.deepEqual(w1!.pressure, ["MemoryPressure"]);
    // Unknown is not True.
    assert.deepEqual(w2!.pressure, []);
    assert.equal(cp!.kubeletVersion, "v1.31.4+k3s1");
    assert.equal(cp!.versionDrift, false);
    assert.equal(cp!.podCapacity, 110);
    assert.equal(cp!.bootTime, "2026-08-08T12:00:00.000Z");
    assert.equal(w2!.bootTime, undefined);
    assert.equal(w1!.filesystemPercent, 71);

    // storageAvailable minus storageReserved, floored at 0.
    assert.equal(cp!.longhornAvailableBytes, 66_571_993_088 - 32_212_254_720);
    assert.equal(w1!.longhornAvailableBytes, 0);
    assert.equal(cp!.sshHostId, undefined);
    assert.equal(cp!.spark, undefined);
  } finally {
    await server.close();
    await mock.close();
  }
});

test("a cordoned node on an older kubelet, and a cluster without Longhorn", async () => {
  const fake = createFakeK8s({
    objects: [
      {
        ref: RESOURCES.nodes,
        items: [
          {
            metadata: { name: "n1", labels: { "node-role.kubernetes.io/master": "true" } },
            spec: { unschedulable: true },
            status: {
              allocatable: { cpu: "2", memory: "4Gi" },
              capacity: { pods: "60" },
              conditions: [
                { type: "Ready", status: "True" },
                { type: "DiskPressure", status: "True" },
                { type: "PIDPressure", status: "True" },
              ],
              nodeInfo: { kubeletVersion: "v1.30.9+k3s1" },
            },
          } as KubeObject,
        ],
      },
    ],
    absentGroups: ["metrics.k8s.io", "longhorn.io"],
  });
  const snapshot = await createScraper(() => fake).scrape();
  const [row] = toNodeRows(snapshot, { hosts: [], now: NOW });
  assert.deepEqual(row!.roles, ["control-plane"]);
  assert.equal(row!.schedulable, false);
  assert.deepEqual(row!.pressure, ["DiskPressure", "PIDPressure"]);
  assert.equal(row!.versionDrift, true);
  assert.equal(row!.podCapacity, 60);
  assert.equal(row!.longhornAvailableBytes, undefined);
});

test("a node matched to a host gets its id, load, boot time and sparklines", async () => {
  const snapshot = await createScraper(() => k8s).scrape();
  const metrics = fakeMetrics([
    {
      series: "node.cpu.percent",
      labels: { node: "cp-1" },
      points: [
        [firstBucket - STEP, 99],
        [firstBucket, 10],
        [firstBucket + 5 * STEP, 12.345],
        [lastBucket, 20],
      ],
    },
    { series: "node.cpu.percent", labels: { node: "worker-1" }, points: [[lastBucket, 50]] },
    { series: "node.net.rx.bytesPerSec", labels: { node: "cp-1" }, points: [] },
    { series: "host.load", labels: { host: "h_cp" }, points: [[lastBucket - STEP, 0.4]] },
  ]);
  const hosts = [
    host("h_cp", "192.168.10.11", { facts: { uptimeSeconds: 3600 }, lastSeenAt: "2026-10-07T12:00:00.000Z" }),
    host("h_w2", "worker-2.lan"),
    host("h_other", "10.9.9.9"),
  ];
  const [cp, w1, w2] = toNodeRows(snapshot, { hosts, metrics, now: NOW });

  assert.equal(cp!.sshHostId, "h_cp");
  assert.equal(w2!.sshHostId, "h_w2");
  assert.equal(w1!.sshHostId, undefined);

  const cpu = cp!.spark!.cpu!;
  assert.equal(cpu.length, NODE_SPARK_POINTS);
  assert.equal(cpu[0], 10);
  assert.equal(cpu[5], 12.35);
  assert.equal(cpu[1], null);
  assert.equal(cpu.at(-1), 20);
  // A metric with no points is left out, not sent as nulls.
  assert.equal(cp!.spark!.netRx, undefined);
  assert.deepEqual(cp!.spark!.load!.slice(-2), [0.4, null]);
  assert.equal(cp!.load1, 0.4);
  assert.equal(w1!.load1, undefined);
  assert.equal(w2!.spark, undefined);

  // The kubelet's start time wins; a host's uptime fills in only without it.
  assert.equal(cp!.bootTime, "2026-08-08T12:00:00.000Z");
  const [cpNoSummary] = toNodeRows(
    { ...snapshot, nodes: snapshot.nodes.map((n) => ({ ...n, bootTime: undefined })) },
    { hosts, now: NOW }
  );
  assert.equal(cpNoSummary!.bootTime, "2026-10-07T11:00:00.000Z");

  assert.ok(metrics.queries.every((q) => q.stepMs === STEP && q.from === firstBucket && q.to === NOW));
});

test("rows survive a failing hosts route and a failing metrics store", async () => {
  const mock = createMockContext("metrics-k8s", {
    services: {
      k8s,
      metrics: {
        query() {
          throw new Error("store closed");
        },
      },
    },
    calls: {
      "GET /api/hosts": () => {
        throw new Error("hosts module down");
      },
    },
  });
  registerMetricsK8s(mock.ctx, { now: () => NOW });
  const server = await listen(mock.app);
  try {
    const res = await fetch(`${server.url}/api/metrics-k8s/nodes`);
    assert.equal(res.status, 200);
    const rows = (await res.json()) as NodeSummary[];
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.spark === undefined && r.sshHostId === undefined));
  } finally {
    await server.close();
    await mock.close();
  }
});

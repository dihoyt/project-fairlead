import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { CheckResult } from "../../../src/contracts/health.js";
import { RESOURCES, type K8sApi, type KubeObject } from "../../../src/contracts/k8s.js";
import type { NodeSummary, Sample } from "../../../src/contracts/metrics.js";
import { createMockContext, type MockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { createK8sService, type K8sService } from "../../../src/modules/k8s/api.js";
import { DEFAULT_THRESHOLDS, judge } from "../../../src/modules/metrics-k8s/health.js";
import mod, { registerMetricsK8s } from "../../../src/modules/metrics-k8s/index.js";
import { parseQuantity } from "../../../src/modules/metrics-k8s/quantity.js";
import { createScraper, nodeCounters, summaryPath, toSamples } from "../../../src/modules/metrics-k8s/scrape.js";
import { loadFixtureSet, scenarios, startFakeApi, type FakeApi, type FixtureSet } from "../../support/index.js";
import { listen } from "../../runtime/helpers.js";

const fixtures = loadFixtureSet("synthetic");
const fast = { watchSeconds: [30, 30] as [number, number], backoffMs: [20, 100] as [number, number] };
const ALLOCATABLE_MEMORY = 16_263_064 * 1024;

interface Cluster {
  api: FakeApi;
  k8s: K8sService;
  close(): Promise<void>;
}

async function cluster(set: FixtureSet = fixtures): Promise<Cluster> {
  const api = await startFakeApi({ fixtures: set });
  const conn = { source: "kubeconfig" as const, server: api.url, context: "fake", kubeConfig: api.kubeConfig() };
  const k8s = createK8sService({ connection: () => conn, timing: fast });
  return {
    api,
    k8s,
    async close() {
      await k8s.close();
      await api.close();
    },
  };
}

function withModule(k8s: K8sApi | undefined, settings: Record<string, unknown> = {}): MockContext {
  const mock = createMockContext("metrics-k8s", { services: k8s ? { k8s } : {}, settings });
  registerMetricsK8s(mock.ctx);
  return mock;
}

const byId = (results: CheckResult[]) => new Map(results.map((r) => [r.id, r]));
const find = (samples: Sample[], series: string, labels: Record<string, string>) =>
  samples.filter((s) => s.series === series && Object.entries(labels).every(([k, v]) => s.labels[k] === v));

test("parses Kubernetes quantities into base units", () => {
  assert.ok(Math.abs(parseQuantity("412000000n")! - 0.412) < 1e-12);
  assert.equal(parseQuantity("250m"), 0.25);
  assert.equal(parseQuantity("4"), 4);
  assert.equal(parseQuantity("16263064Ki"), ALLOCATABLE_MEMORY);
  assert.equal(parseQuantity("1.5Gi"), 1.5 * 2 ** 30);
  assert.equal(parseQuantity("2M"), 2e6);
  assert.equal(parseQuantity("1e3"), 1000);
  assert.equal(parseQuantity("12x"), undefined);
  assert.equal(parseQuantity(undefined), undefined);
});

test("the module registers a collector, a health provider and the nodes route", () => {
  const mock = createMockContext("metrics-k8s");
  mod.register(mock.ctx);
  assert.deepEqual(
    mock.ctx.metrics.list().map((c) => c.id),
    ["metrics-k8s"]
  );
  assert.deepEqual(
    mock.ctx.health.list().map((p) => [p.id, p.category]),
    [["metrics-k8s", "cluster"]]
  );
});

// --- against the fake API server's kubelet endpoints -----------------------

let real: Cluster;
before(async () => {
  real = await cluster();
});
after(async () => {
  await real.close();
});

test("node usage comes from each kubelet's Summary API through the API server proxy", async () => {
  const mock = withModule(real.k8s);
  try {
    const samples = await mock.ctx.metrics.list()[0]!.collect();

    const cpu = find(samples, "node.cpu.percent", { node: "cp-1" });
    assert.equal(cpu.length, 1);
    assert.equal(cpu[0]!.value, 10.3); // 412m of 4 cores
    assert.equal(find(samples, "node.cpu.cores", { node: "worker-1" })[0]!.value, 1.83);

    const memory = find(samples, "node.memory.percent", { node: "worker-1" })[0]!.value;
    assert.equal(memory, Math.round((15_210_000_000 / ALLOCATABLE_MEMORY) * 10_000) / 100);
    assert.equal(find(samples, "node.memory.bytes", { node: "worker-1" })[0]!.value, 15_210_000_000);
    assert.equal(find(samples, "node.fs.percent", { node: "worker-1" })[0]!.value, 71);
    assert.equal(find(samples, "node.fs.used.bytes", { node: "cp-1" })[0]!.value, 38 * 2 ** 30);

    // Pod count from the pod list: running and pending pods bound to the node.
    assert.equal(find(samples, "node.pods.count", { node: "cp-1" })[0]!.value, 7);
    assert.equal(find(samples, "node.pods.count", { node: "worker-1" })[0]!.value, 7);

    // A node with no kubelet summary and no metrics-server entry reports nothing but its pod count.
    assert.equal(find(samples, "node.cpu.percent", { node: "worker-2" }).length, 0);
    assert.equal(find(samples, "node.pods.count", { node: "worker-2" })[0]!.value, 1);

    // Container usage from the summary's pods, labelled with where it runs.
    const pvc = scenarios.pvcs.protected;
    const containerCpu = samples.filter(
      (s) => s.series === "container.cpu.percent" && s.labels.namespace === pvc.namespace
    );
    assert.ok(containerCpu.length > 0);
    assert.equal(containerCpu[0]!.value, 2); // 20m is 2% of a core
    assert.equal(containerCpu[0]!.labels.node, "worker-1");
    assert.equal(containerCpu[0]!.labels.container, "app");
    assert.ok(samples.some((s) => s.series === "container.memory.bytes" && s.value === 2.5e8));

    // Restarts from container statuses, for every container in a live pod.
    const restarts = find(samples, "container.restarts.count", {
      namespace: "default",
      pod: "report-worker-6c8d7f9b4-m5v2n",
      container: "report",
    });
    assert.equal(restarts[0]!.value, 27);
    assert.equal(restarts[0]!.labels.node, "worker-1");
    assert.equal(find(samples, "container.restarts.count", { pod: "nightly-db-dump-29326800-8h2kd" }).length, 0);

    const paths = real.api.requests.map((r) => r.path);
    assert.ok(paths.some((p) => p.startsWith(summaryPath("cp-1"))));
    // worker-2 has no summary, so metrics-server is asked for it.
    assert.ok(paths.some((p) => p.startsWith("/apis/metrics.k8s.io/v1beta1/nodes")));
  } finally {
    await mock.close();
  }
});

test("the nodes route summarises the latest read", async () => {
  const mock = withModule(real.k8s);
  const server = await listen(mock.app);
  try {
    const res = await fetch(`${server.url}/api/metrics-k8s/nodes`);
    assert.equal(res.status, 200);
    const nodes = (await res.json()) as NodeSummary[];
    assert.deepEqual(
      nodes.map((n) => [n.name, n.ready, n.source, n.pods]),
      [
        ["cp-1", true, "kubelet", 7],
        ["worker-1", true, "kubelet", 7],
        ["worker-2", false, "none", 1],
      ]
    );
    assert.equal(nodes[0]!.cpuPercent, 10.3);
    assert.equal(nodes[2]!.cpuPercent, undefined);
  } finally {
    await server.close();
    await mock.close();
  }
});

test("usage thresholds become health checks per node", async () => {
  const mock = withModule(real.k8s);
  try {
    const results = byId(await mock.ctx.health.list()[0]!.collect());
    assert.equal(results.get("collection")!.status, "ok");
    assert.match(results.get("collection")!.detail, /2 of 2 Ready nodes via the kubelet/);

    assert.equal(results.get("memory:cp-1")!.status, "ok");
    const worker = results.get("memory:worker-1")!;
    assert.equal(worker.status, "warn"); // 91% against 85/95
    assert.ok(worker.raw, "a failing check carries its raw data");
    assert.equal(results.get("disk:worker-1")!.status, "ok");
    assert.equal(results.get("disk:worker-1")!.raw, undefined);
    assert.match(results.get("disk:cp-1")!.detail, /38\.0% of the node filesystem used/);

    assert.equal(results.get("memory:worker-2")!.status, "unknown");
    assert.match(results.get("memory:worker-2")!.detail, /not Ready/);
    for (const r of results.values()) assert.ok(r.detail.length > 0 && r.observedAt);
    assert.deepEqual(results.get("disk:cp-1")!.object, { kind: "Node", name: "cp-1" });
  } finally {
    await mock.close();
  }

  const strict = withModule(real.k8s, { "metrics-k8s.memoryCritPercent": 90, "metrics-k8s.diskWarnPercent": 70 });
  try {
    const results = byId(await strict.ctx.health.list()[0]!.collect());
    assert.equal(results.get("memory:worker-1")!.status, "crit");
    assert.equal(results.get("disk:worker-1")!.status, "warn");
    assert.equal(results.get("disk:cp-1")!.status, "ok");
  } finally {
    await strict.close();
  }
});

test("without kubelet stats, metrics-server fills in CPU and memory", async () => {
  const noKubelet = await cluster({ ...fixtures, kubelet: {} });
  const mock = withModule(noKubelet.k8s);
  const server = await listen(mock.app);
  try {
    const samples = await mock.ctx.metrics.list()[0]!.collect();
    assert.equal(find(samples, "node.cpu.percent", { node: "cp-1" })[0]!.value, 10.3);
    assert.equal(find(samples, "node.memory.bytes", { node: "worker-1" })[0]!.value, 15_575_040 * 1024);
    assert.equal(find(samples, "node.fs.percent", {}).length, 0);
    const web = find(samples, "container.cpu.percent", { pod: "web-7d9f8b6c5d-x2k4q", container: "web" });
    assert.equal(web[0]!.value, 1.2);
    assert.equal(web[0]!.labels.node, "worker-1");

    const results = byId(await mock.ctx.health.list()[0]!.collect());
    assert.equal(results.get("collection")!.status, "ok");
    assert.match(results.get("collection")!.detail, /0 of 2 Ready nodes via the kubelet, 2 via metrics-server/);
    assert.equal(results.get("disk:cp-1")!.status, "absent");
    assert.equal(results.get("memory:worker-1")!.status, "crit"); // 95.8% by metrics-server's figure

    const nodes = (await (await fetch(`${server.url}/api/metrics-k8s/nodes`)).json()) as NodeSummary[];
    assert.equal(nodes.find((n) => n.name === "cp-1")!.source, "metrics-server");
  } finally {
    await server.close();
    await mock.close();
    await noKubelet.close();
  }
});

test("a Ready node with no data from either source is a warning", async () => {
  const set: FixtureSet = { ...fixtures, kubelet: { "cp-1": fixtures.kubelet["cp-1"]! } };
  const partial = await cluster(set);
  try {
    // worker-1 still has metrics-server; drop it from there too.
    const scraper = createScraper(() => ({
      ...partial.k8s,
      list: async <T extends KubeObject>(ref: Parameters<K8sApi["list"]>[0], opts?: Parameters<K8sApi["list"]>[1]) =>
        ref === RESOURCES.nodeMetrics ? ("absent" as const) : partial.k8s.list<T>(ref, opts),
    }));
    const snapshot = await scraper.scrape();
    const worker = snapshot.nodes.find((n) => n.name === "worker-1")!;
    assert.equal(worker.source, "none");
    assert.match(worker.kubeletError!, /no kubelet summary/);
    const results = byId(judge(snapshot, DEFAULT_THRESHOLDS));
    assert.equal(results.get("collection")!.status, "warn");
    assert.match(results.get("collection")!.detail, /No usage data for worker-1/);
    assert.equal(results.get("memory:worker-1")!.status, "unknown");
    assert.equal(results.get("disk:worker-1")!.status, "unknown");
  } finally {
    await partial.close();
  }
});

// --- with the in-memory fake ----------------------------------------------

const node = (name: string): KubeObject => ({
  metadata: { name },
  status: {
    allocatable: { cpu: "2", memory: "4Gi" },
    conditions: [{ type: "Ready", status: "True" }],
  },
});

function summary(time: string, rxBytes: number, txBytes: number) {
  return {
    node: {
      cpu: { time, usageNanoCores: 500_000_000 },
      memory: { time, workingSetBytes: 2 * 2 ** 30 },
      fs: { time, availableBytes: 10 * 2 ** 30, capacityBytes: 40 * 2 ** 30, inodes: 100, inodesUsed: 95 },
      network: { time, rxBytes, txBytes },
    },
    pods: [],
  };
}

test("network counters become rates between reads, skipping cached and reset counters", async () => {
  const raw: Record<string, unknown> = { [summaryPath("n1")]: summary("2026-10-07T12:00:00Z", 1_000, 5_000) };
  const fake = createFakeK8s({ objects: [{ ref: RESOURCES.nodes, items: [node("n1")] }], raw });
  let now = Date.parse("2026-10-07T12:00:05Z");
  const scraper = createScraper(() => fake, { now: () => now });

  const first = await scraper.scrape();
  assert.equal(first.nodes[0]!.rxBytesPerSec, undefined);
  assert.equal(first.nodes[0]!.cpuPercent, 25);
  assert.equal(first.nodes[0]!.memoryPercent, 50);
  assert.equal(first.nodes[0]!.fs!.percent, 75);
  assert.equal(first.nodes[0]!.fs!.inodesPercent, 95);

  raw[summaryPath("n1")] = summary("2026-10-07T12:00:30Z", 31_000, 8_000);
  now += 30_000;
  const second = await scraper.scrape();
  assert.equal(second.nodes[0]!.rxBytesPerSec, 1_000);
  assert.equal(second.nodes[0]!.txBytesPerSec, 100);
  const samples = toSamples(second);
  assert.equal(find(samples, "node.net.rx.bytesPerSec", { node: "n1" })[0]!.value, 1_000);
  assert.ok(samples.every((s) => s.ts === now));

  // Same kubelet timestamp: the kubelet served its cache.
  now += 5_000;
  assert.equal((await scraper.scrape()).nodes[0]!.rxBytesPerSec, undefined);

  // Counter went backwards: the node rebooted.
  raw[summaryPath("n1")] = summary("2026-10-07T12:01:00Z", 10, 10);
  now += 25_000;
  assert.equal((await scraper.scrape()).nodes[0]!.rxBytesPerSec, undefined);
});

// k3s on a VM: the NIC is ens18, so the kubelet leaves the top-level
// counters out and lists the interfaces, pod and overlay bridges included.
function vmSummary(time: string, ens18: [number, number]) {
  const base = summary(time, 0, 0);
  return {
    node: {
      ...base.node,
      network: {
        time,
        name: "",
        interfaces: [
          { name: "ens18", rxBytes: ens18[0], txBytes: ens18[1] },
          { name: "flannel.1", rxBytes: 900_000, txBytes: 900_000 },
          { name: "cni0", rxBytes: 700_000, txBytes: 700_000 },
          { name: "veth1a2b3c4d", rxBytes: 500_000, txBytes: 500_000 },
        ],
      },
    },
    pods: base.pods,
  };
}

test("a node whose NIC is not eth0 gets network rates from its physical interfaces", async () => {
  const raw: Record<string, unknown> = { [summaryPath("n1")]: vmSummary("2026-10-07T12:00:00Z", [1_000, 5_000]) };
  const fake = createFakeK8s({ objects: [{ ref: RESOURCES.nodes, items: [node("n1")] }], raw });
  let now = Date.parse("2026-10-07T12:00:05Z");
  const scraper = createScraper(() => fake, { now: () => now });
  await scraper.scrape();

  raw[summaryPath("n1")] = vmSummary("2026-10-07T12:00:30Z", [31_000, 8_000]);
  now += 30_000;
  const second = await scraper.scrape();
  assert.equal(second.nodes[0]!.rxBytesPerSec, 1_000);
  assert.equal(second.nodes[0]!.txBytesPerSec, 100);
  assert.equal(find(toSamples(second), "node.net.tx.bytesPerSec", { node: "n1" })[0]!.value, 100);
});

test("the captured k3s summary counts ens18 and leaves flannel and cni0 out", () => {
  const captured = JSON.parse(
    readFileSync(new URL("../../fixtures/real/kubelet/summary-agent-1.json", import.meta.url), "utf8")
  ) as { node: { network: Parameters<typeof nodeCounters>[0] } };
  assert.equal(captured.node.network!.rxBytes, undefined);
  assert.deepEqual(nodeCounters(captured.node.network), { rx: 23_989_698_577, tx: 9_307_985_674 });
  assert.deepEqual(nodeCounters({ rxBytes: 1, txBytes: 2, interfaces: [{ name: "eth0", rxBytes: 9, txBytes: 9 }] }), {
    rx: 1,
    tx: 2,
  });
  assert.equal(nodeCounters({ interfaces: [{ name: "lo", rxBytes: 9, txBytes: 9 }] }), undefined);
});

test("inodes count toward the disk check when they are fuller than the bytes", async () => {
  const raw = { [summaryPath("n1")]: summary("2026-10-07T12:00:00Z", 0, 0) };
  const fake = createFakeK8s({ objects: [{ ref: RESOURCES.nodes, items: [node("n1")] }], raw });
  const mock = withModule(fake);
  try {
    const disk = byId(await mock.ctx.health.list()[0]!.collect()).get("disk:n1")!;
    assert.equal(disk.status, "crit");
    assert.equal(disk.value, 95);
    assert.match(disk.detail, /95\.0% of inodes/);
  } finally {
    await mock.close();
  }
});

test("a forbidden kubelet proxy says what to grant", async () => {
  const fake = createFakeK8s({
    objects: [{ ref: RESOURCES.nodes, items: [node("n1")] }],
    absentGroups: ["metrics.k8s.io"],
  });
  const forbidden: K8sApi = {
    ...fake,
    raw: async () => {
      throw Object.assign(new Error('nodes "n1" is forbidden'), { statusCode: 403 });
    },
  };
  const snapshot = await createScraper(() => forbidden).scrape();
  assert.equal(snapshot.nodes[0]!.source, "none");
  assert.match(snapshot.nodes[0]!.kubeletError!, /needs get on nodes\/proxy/);
});

test("concurrent reads share one scrape, and recent() reuses a fresh one", async () => {
  const raw = { [summaryPath("n1")]: summary("2026-10-07T12:00:00Z", 0, 0) };
  let calls = 0;
  const fake = createFakeK8s({ objects: [{ ref: RESOURCES.nodes, items: [node("n1")] }], raw });
  const counted: K8sApi = {
    ...fake,
    raw: (path) => {
      calls++;
      return fake.raw(path);
    },
  };
  let now = 1_000_000;
  const scraper = createScraper(() => counted, { now: () => now });
  const [a, b] = await Promise.all([scraper.scrape(), scraper.scrape()]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  assert.equal(await scraper.recent(30_000), a);
  now += 30_000;
  assert.notEqual(await scraper.recent(30_000), a);
  assert.equal(calls, 2);
});

test("a slow kubelet times out instead of stalling the read", async () => {
  const fake = createFakeK8s({
    objects: [{ ref: RESOURCES.nodes, items: [node("n1")] }],
    absentGroups: ["metrics.k8s.io"],
  });
  const slow: K8sApi = { ...fake, raw: () => new Promise(() => {}) };
  const snapshot = await createScraper(() => slow, { kubeletTimeoutMs: 50 }).scrape();
  assert.match(snapshot.nodes[0]!.kubeletError!, /timed out/);
});

test("with no Kubernetes service, nothing is collected and health says why", async () => {
  const mock = withModule(undefined);
  const server = await listen(mock.app);
  try {
    assert.deepEqual(await mock.ctx.metrics.list()[0]!.collect(), []);
    const results = await mock.ctx.health.list()[0]!.collect();
    assert.equal(results.length, 1);
    assert.equal(results[0]!.status, "unknown");
    assert.match(results[0]!.detail, /Could not list nodes/);
    const res = await fetch(`${server.url}/api/metrics-k8s/nodes`);
    assert.equal(res.status, 503);
    assert.match(((await res.json()) as { error: string }).error, /Could not list nodes/);
  } finally {
    await server.close();
    await mock.close();
  }
});

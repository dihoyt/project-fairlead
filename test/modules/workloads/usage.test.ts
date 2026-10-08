import { test } from "node:test";
import assert from "node:assert/strict";
import type { SeriesQuery, SeriesResult } from "../../../src/contracts/metrics.js";
import type { MetricsQuery } from "../../../src/contracts/runtime.js";
import {
  clusterUsage,
  ownerByName,
  parseRange,
  quantity,
  spaceUsage,
  type UsageInputs,
} from "../../../src/modules/workloads/usage.js";
import { intermediates, type Pod } from "../../../src/modules/workloads/views.js";
import { HttpError } from "../../../src/runtime/http.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const MiB = 2 ** 20;

// A store-like query over fixed raw samples: buckets of stepMs, mean per bucket.
function fakeMetrics(samples: Array<{ series: string; labels: Record<string, string>; ts: number; value: number }>) {
  const query = (q: SeriesQuery): SeriesResult[] => {
    const groups = new Map<string, { labels: Record<string, string>; points: Map<number, number[]> }>();
    for (const s of samples) {
      if (s.series !== q.series || s.ts < q.from || s.ts > q.to) continue;
      if (!Object.entries(q.labels ?? {}).every(([k, v]) => s.labels[k] === v)) continue;
      const key = JSON.stringify(s.labels);
      const g = groups.get(key) ?? { labels: s.labels, points: new Map() };
      const step = q.stepMs ?? 1;
      const b = Math.floor(s.ts / step) * step;
      g.points.set(b, [...(g.points.get(b) ?? []), s.value]);
      groups.set(key, g);
    }
    return [...groups.values()].map((g) => ({
      series: q.series,
      labels: g.labels,
      points: [...g.points]
        .toSorted(([a], [b]) => a - b)
        .map(([ts, vs]) => [ts, vs.reduce((x, y) => x + y, 0) / vs.length] as [number, number]),
    }));
  };
  return { query } satisfies MetricsQuery;
}

function scrape(ns: string, podName: string, container: string, cpuPercent: number, memBytes: number, ts: number) {
  const labels = { namespace: ns, pod: podName, container, node: "node-1" };
  return [
    { series: "container.cpu.percent", labels, ts, value: cpuPercent },
    { series: "container.memory.bytes", labels, ts, value: memBytes },
  ];
}

function pod(
  ns: string,
  name: string,
  owner: { kind: string; name: string } | undefined,
  containers: Array<{ name: string; resources?: object }>,
  phase = "Running"
): Pod {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      namespace: ns,
      name,
      uid: name,
      ...(owner ? { ownerReferences: [{ ...owner, apiVersion: "apps/v1", uid: "x", controller: true }] } : {}),
    },
    spec: { containers } as Pod["spec"],
    status: { phase },
  } as Pod;
}

const rs = {
  apiVersion: "apps/v1",
  kind: "ReplicaSet",
  metadata: {
    namespace: "media",
    name: "web-5d8f9",
    uid: "rs",
    ownerReferences: [{ kind: "Deployment", name: "web", apiVersion: "apps/v1", uid: "d", controller: true }],
  },
};

const resources = (cpu: string, mem: string, limits?: { cpu?: string; memory?: string }) => ({
  requests: { cpu, memory: mem },
  ...(limits ? { limits } : {}),
});

function inputs(samples: ReturnType<typeof scrape>, extra: Partial<UsageInputs> = {}): UsageInputs {
  return {
    pods: [
      pod("media", "web-5d8f9-abcde", { kind: "ReplicaSet", name: "web-5d8f9" }, [
        { name: "app", resources: resources("250m", "128Mi", { cpu: "1", memory: "256Mi" }) },
        { name: "sidecar", resources: resources("50m", "32Mi") },
      ]),
      pod("media", "db-0", { kind: "StatefulSet", name: "db" }, [
        { name: "pg", resources: resources("500m", "1Gi", { cpu: "2", memory: "2Gi" }) },
      ]),
      pod("media", "done-xyz12", undefined, [{ name: "c", resources: resources("4", "4Gi") }], "Succeeded"),
      pod("other", "lone", undefined, [{ name: "c" }]),
    ],
    workloads: [
      { namespace: "media", kind: "Deployment", name: "web" },
      { namespace: "media", kind: "StatefulSet", name: "db" },
    ],
    through: intermediates([rs], []),
    metrics: fakeMetrics(samples),
    range: "1h",
    now: NOW,
    ...extra,
  };
}

const samples = [
  // Two scrapes of the current pods, 30 s apart, newest 20 s ago.
  ...[NOW - 50_000, NOW - 20_000].flatMap((ts) => [
    ...scrape("media", "web-5d8f9-abcde", "app", 20, 100 * MiB, ts),
    ...scrape("media", "web-5d8f9-abcde", "sidecar", 5, 10 * MiB, ts),
    ...scrape("media", "db-0", "pg", 50, 500 * MiB, ts),
  ]),
  // A replaced web pod, gone 30 minutes ago: counted into Deployment/web.
  ...scrape("media", "web-5d8f9-old11", "app", 80, 200 * MiB, NOW - 30 * MIN),
];

test("quantities parse in base units; ranges default to 1h and refuse others", () => {
  assert.equal(quantity("250m"), 0.25);
  assert.equal(quantity("128Mi"), 128 * MiB);
  assert.equal(quantity("1G"), 1e9);
  assert.equal(quantity("abc"), undefined);
  assert.equal(parseRange(undefined), "1h");
  assert.equal(parseRange("7d"), "7d");
  assert.throws(() => parseRange("2h"), HttpError);
});

test("pods that are gone are traced to their workload by name", () => {
  const workloads = [
    { namespace: "a", kind: "Deployment" as const, name: "web" },
    { namespace: "a", kind: "Deployment" as const, name: "web-api" },
    { namespace: "a", kind: "StatefulSet" as const, name: "db" },
    { namespace: "a", kind: "CronJob" as const, name: "backup" },
  ];
  assert.equal(ownerByName("web-api-5d8f9-abcde", workloads), "Deployment/web-api");
  assert.equal(ownerByName("web-5d8f9-abcde", workloads), "Deployment/web");
  assert.equal(ownerByName("db-2", workloads), "StatefulSet/db");
  assert.equal(ownerByName("backup-28912345-x1y2z", workloads), "CronJob/backup");
  assert.equal(ownerByName("dbx-0", workloads), undefined);
});

test("cluster usage sums containers per namespace with requests and limits", () => {
  const report = clusterUsage(inputs(samples));
  assert.equal(report.collected, true);
  assert.equal(report.to - report.from, 60 * MIN);
  const media = report.namespaces.find((n) => n.namespace === "media")!;
  // Current: the newest scrape only; the old pod's last sample is too old.
  assert.equal(media.cpu.current, 0.75);
  assert.equal(media.memory.current, 610 * MiB);
  // Requests over live pods; the finished pod's 4 cores don't count.
  assert.equal(media.cpu.request, 0.8);
  // The sidecar has no limit, so the namespace is unlimited.
  assert.equal(media.cpu.limit, undefined);
  assert.ok(media.cpu.peak! >= media.cpu.avg!);
  assert.ok(media.cpuPoints!.length >= 2);
  const other = report.namespaces.find((n) => n.namespace === "other")!;
  assert.deepEqual(other.cpu, {});
});

test("space usage per workload, pod and container", () => {
  const report = spaceUsage("media", inputs(samples));
  const web = report.workloads.find((w) => w.name === "web")!;
  assert.equal(web.pods, 1);
  // The replaced pod's spike is part of the workload's peak.
  assert.equal(web.cpu.peak, 0.8);
  assert.equal(web.cpu.current, 0.25);
  assert.equal(web.memory.request, 160 * MiB);
  const db = report.workloads.find((w) => w.name === "db")!;
  assert.deepEqual(
    { request: db.cpu.request, limit: db.cpu.limit, current: db.cpu.current },
    { request: 0.5, limit: 2, current: 0.5 }
  );

  assert.deepEqual(
    report.pods.map((p) => p.name),
    ["db-0", "web-5d8f9-abcde"]
  );
  const webPod = report.pods.find((p) => p.name.startsWith("web"))!;
  assert.equal(webPod.owner, "Deployment/web");
  const app = webPod.containers.find((c) => c.name === "app")!;
  assert.deepEqual(app.memory, {
    current: 100 * MiB,
    avg: 100 * MiB,
    peak: 100 * MiB,
    request: 128 * MiB,
    limit: 256 * MiB,
  });
  assert.equal("cpuPoints" in app, false);
});

test("without samples the report says so and still carries requests and limits", () => {
  const report = spaceUsage("media", inputs([], { metrics: undefined }));
  assert.equal(report.collected, false);
  const db = report.workloads.find((w) => w.name === "db")!;
  assert.deepEqual(db.cpu, { request: 0.5, limit: 2 });
  assert.equal(db.cpuPoints, undefined);
});

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { RESOURCES, type K8sApi, type KubeObject } from "../../../src/contracts/k8s.js";
import type {
  EventView,
  LogLines,
  NamespaceView,
  PodView,
  WorkloadLinks,
  WorkloadView,
} from "../../../src/contracts/workloads.js";
import { createMockContext, type MockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { createK8sService, type K8sService } from "../../../src/modules/k8s/api.js";
import mod from "../../../src/modules/workloads/index.js";
import { ObjectCache } from "../../../src/modules/workloads/cache.js";
import { MASK, createRedactor, referencedSecrets } from "../../../src/modules/workloads/redact.js";
import { loadFixtureSet, startFakeApi, type FakeApi } from "../../support/index.js";
import { listen } from "../../runtime/helpers.js";

const fixtures = loadFixtureSet("synthetic");
const fast = { watchSeconds: [30, 30] as [number, number], backoffMs: [20, 100] as [number, number] };

let api: FakeApi;
let k8s: K8sService;
let mock: MockContext;
let server: { url: string; close(): Promise<void> };

before(async () => {
  api = await startFakeApi({ fixtures });
  const conn = { source: "kubeconfig" as const, server: api.url, context: "fake", kubeConfig: api.kubeConfig() };
  k8s = createK8sService({ connection: () => conn, timing: fast });
  mock = createMockContext("workloads", { services: { k8s } });
  await mod.register(mock.ctx);
  server = await listen(mock.app);
});
after(async () => {
  await server.close();
  await mock.close();
  await k8s.close();
  await api.close();
});

async function get<T>(path: string, expect = 200): Promise<T> {
  const res = await fetch(`${server.url}/api/workloads${path}`);
  const body = (await res.json()) as T;
  assert.equal(res.status, expect, JSON.stringify(body));
  return body;
}

test("links are empty until configured, and trailing slashes are trimmed", async () => {
  assert.deepEqual(await get<WorkloadLinks>("/links"), {});
  const local = createMockContext("workloads", {
    services: { k8s },
    settings: {
      "workloads.headlampUrl": "https://headlamp.example.test/",
      "workloads.rancherUrl": "https://r.example.test",
    },
  });
  await mod.register(local.ctx);
  const srv = await listen(local.app);
  try {
    const links = (await (await fetch(`${srv.url}/api/workloads/links`)).json()) as WorkloadLinks;
    assert.deepEqual(links, {
      headlamp: { url: "https://headlamp.example.test", cluster: "main" },
      rancher: { url: "https://r.example.test", clusterId: "local" },
    });
  } finally {
    await srv.close();
    await local.close();
  }
});

test("namespaces carry workload and pod counts, with unhealthy pods counted", async () => {
  const spaces = await get<NamespaceView[]>("/namespaces");
  assert.deepEqual(
    spaces.map((s) => s.name),
    spaces.map((s) => s.name).toSorted()
  );
  const def = spaces.find((s) => s.name === "default")!;
  assert.equal(def.status, "Active");
  assert.equal(def.pods, 7);
  // report-worker crashloops, batch-import is unschedulable, legacy-app can't pull;
  // the finished nightly dump is not unhealthy.
  assert.equal(def.unhealthyPods, 3);
  // Five Deployments and one CronJob; the CronJob's Jobs are not counted beside it.
  assert.equal(def.workloads, 6);
  assert.equal(spaces.find((s) => s.name === "longhorn-system")!.workloads, 1);
});

test("workloads list every kind, CronJob-owned Jobs folded into their CronJob", async () => {
  const items = await get<WorkloadView[]>("/namespaces/default/workloads");
  assert.deepEqual(
    items.map((w) => `${w.kind}/${w.name}`),
    [
      "Deployment/batch-import",
      "Deployment/legacy-app",
      "Deployment/report-worker",
      "Deployment/uploads-api",
      "Deployment/web",
      "CronJob/nightly-db-dump",
    ]
  );
  const web = items.find((w) => w.name === "web")!;
  assert.match(web.ready, /^\d+\/\d+$/);
  assert.ok(web.images.length > 0);

  const ds = await get<WorkloadView[]>("/namespaces/longhorn-system/workloads");
  assert.equal(ds[0]!.kind, "DaemonSet");
  const sts = await get<WorkloadView[]>("/namespaces/databases/workloads");
  assert.equal(sts[0]!.kind, "StatefulSet");
});

test("pods resolve their owner through ReplicaSets and Jobs, and filter by workload", async () => {
  const pods = await get<PodView[]>("/namespaces/default/pods");
  const owner = (name: string) => pods.find((p) => p.name.startsWith(name))!.owner;
  assert.equal(owner("web-"), "Deployment/web");
  assert.equal(owner("nightly-db-dump-"), "CronJob/nightly-db-dump");
  // No ReplicaSet in the fixtures for this one: the direct owner stands.
  assert.equal(owner("uploads-api-"), "ReplicaSet/uploads-api-5c6d8f7b9");

  const web = await get<PodView[]>("/namespaces/default/pods?workload=Deployment/web");
  assert.equal(web.length, 2);
  assert.ok(web.every((p) => p.owner === "Deployment/web"));

  const crash = await get<PodView>("/namespaces/default/pods/report-worker-6c8d7f9b4-m5v2n");
  assert.equal(crash.restarts, 27);
  assert.equal(crash.ready, "0/1");
  assert.equal(crash.containers[0]!.state, "waiting");
  assert.equal(crash.containers[0]!.reason, "CrashLoopBackOff");

  const done = await get<PodView>("/namespaces/default/pods/nightly-db-dump-29326800-8h2kd");
  assert.equal(done.containers[0]!.state, "terminated");
  assert.equal(done.containers[0]!.reason, "Completed");
});

test("unknown spaces and pods answer 404", async () => {
  await get("/namespaces/nope/workloads", 404);
  await get("/namespaces/nope/pods", 404);
  await get("/namespaces/default/pods/nope", 404);
  await get("/namespaces/default/pods/nope/logs", 404);
});

test("events are newest first, and a workload's include its pods'", async () => {
  const all = await get<EventView[]>("/namespaces/default/events");
  assert.ok(all.length >= 5);
  const times = all.map((e) => Date.parse(e.lastSeen));
  assert.deepEqual(
    times,
    times.toSorted((a, b) => b - a)
  );

  const pod = await get<EventView[]>("/namespaces/default/events?object=Pod/legacy-app-84f6d5c7b9-t4r6y");
  assert.deepEqual(pod.map((e) => e.reason).toSorted(), ["BackOff", "Failed"]);

  const deployment = await get<EventView[]>("/namespaces/default/events?object=Deployment/report-worker");
  assert.deepEqual(
    deployment.map((e) => e.object),
    ["Pod/report-worker-6c8d7f9b4-m5v2n"]
  );
  assert.equal(deployment[0]!.type, "Warning");

  const media = await get<EventView[]>("/namespaces/media/events");
  assert.ok(media.every((e) => e.object !== "Node/worker-1"));
});

test("logs return the tail, report truncation and refuse unknown containers", async () => {
  const full = await get<LogLines>("/namespaces/default/pods/report-worker-6c8d7f9b4-m5v2n/logs");
  assert.equal(full.lines.length, 4);
  assert.equal(full.truncated, false);
  assert.equal(full.redacted, 0);
  assert.match(full.lines[2]!, /password authentication failed/);

  const tail = await get<LogLines>("/namespaces/default/pods/report-worker-6c8d7f9b4-m5v2n/logs?tail=2");
  assert.deepEqual(tail.lines, full.lines.slice(-2));
  assert.equal(tail.truncated, true);

  await get("/namespaces/default/pods/report-worker-6c8d7f9b4-m5v2n/logs?container=other", 404);
  await get("/namespaces/default/pods/report-worker-6c8d7f9b4-m5v2n/logs?tail=0", 400);
});

test("the log stream sends one JSON line per event and ends with the log", async () => {
  const res = await fetch(`${server.url}/api/workloads/namespaces/default/pods/web-7d9f8b6c5d-x2k4q/logs/stream`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
  const text = await res.text();
  const lines = text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => (JSON.parse(l.slice(6)) as { line: string }).line);
  assert.ok(lines.length > 0);
  assert.ok(lines.every((l) => /GET \/healthz/.test(l)));
});

// --- redaction, over the in-memory fake ----------------------------------

const secretPod: KubeObject = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: "app-1", namespace: "apps", creationTimestamp: "2026-10-01T00:00:00Z" },
  spec: {
    containers: [
      {
        name: "app",
        image: "app:1",
        env: [{ name: "DB_PASS", valueFrom: { secretKeyRef: { name: "db", key: "password" } } }],
        envFrom: [{ secretRef: { name: "api" } }],
      },
    ],
    volumes: [{ name: "tls", secret: { secretName: "tls" } }],
  },
  status: {
    phase: "Running",
    containerStatuses: [{ name: "app", ready: true, restartCount: 0, state: { running: {} } }],
  },
};

const b64 = (s: string) => Buffer.from(s).toString("base64");

test("referenced secrets come from env, envFrom and volumes", () => {
  assert.deepEqual(referencedSecrets(secretPod), ["api", "db", "tls"]);
});

test("log lines are masked by Secret value, base64 form and credential patterns", async () => {
  const fake = createFakeK8s({
    objects: [
      {
        ref: RESOURCES.namespaces,
        items: [{ metadata: { name: "apps" }, status: { phase: "Active" } }],
      },
      { ref: RESOURCES.pods, items: [secretPod] },
      {
        ref: RESOURCES.secrets,
        items: [
          { metadata: { name: "db", namespace: "apps" }, data: { password: b64("hunter2-long") } },
          { metadata: { name: "api", namespace: "apps" }, data: { KEY: b64("abc") } },
        ],
      },
    ],
    logs: {
      "apps/app-1": [
        "connecting with hunter2-long",
        `join url ?p=${b64("hunter2-long")}`,
        "Password=s3cret&next=1",
        "Authorization: Bearer eyJhbGciOi.payload.sig",
        "short value abc stays",
        "nothing here",
      ],
    },
  });
  const local = createMockContext("workloads", { services: { k8s: fake } });
  await mod.register(local.ctx);
  const srv = await listen(local.app);
  try {
    const res = await fetch(`${srv.url}/api/workloads/namespaces/apps/pods/app-1/logs`);
    const body = (await res.json()) as LogLines;
    assert.equal(res.status, 200);
    assert.deepEqual(body.lines, [
      `connecting with ${MASK}`,
      `join url ?p=${MASK}`,
      `Password=${MASK}&next=1`,
      `Authorization: Bearer ${MASK}`,
      "short value abc stays",
      "nothing here",
    ]);
    assert.equal(body.redacted, 4);
  } finally {
    await srv.close();
    await local.close();
  }
});

test("credential patterns leave ordinary words alone", () => {
  const redact = createRedactor([]);
  for (const line of ['password authentication failed for user "x"', "token_count: 5", "secretName: tls"]) {
    assert.deepEqual(redact(line), { line, redacted: false });
  }
  assert.equal(redact("DB_PASSWORD=abc").line, `DB_PASSWORD=${MASK}`);
  assert.equal(redact('api_key: "xyz"').line, `api_key: "${MASK}"`);
});

// --- the watch cache -------------------------------------------------------

test("a forbidden resource answers 403 and is not retried until the retry window passes", async () => {
  let now = 0;
  let calls = 0;
  const fake = createFakeK8s();
  const forbidden = {
    ...fake,
    async watch() {
      calls++;
      throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    },
  };
  const cache = new ObjectCache({ k8s: () => forbidden, retryMs: 1000, now: () => now });
  await assert.rejects(cache.list(RESOURCES.pods), { status: 403 });
  await assert.rejects(cache.list(RESOURCES.pods), { status: 403 });
  assert.equal(calls, 1);
  now = 2000;
  await assert.rejects(cache.list(RESOURCES.pods), { status: 403 });
  assert.equal(calls, 2);
});

test("absent resources read as empty, and idle watches are stopped", async () => {
  let now = 0;
  let stopped = 0;
  const fake = createFakeK8s({ absentGroups: ["batch"], objects: [{ ref: RESOURCES.pods, items: [secretPod] }] });
  const counting: K8sApi = {
    ...fake,
    async watch(...args: Parameters<K8sApi["watch"]>) {
      const watch = await fake.watch(...args);
      if (watch === "absent") return watch;
      return { ...watch, stop: () => void stopped++ } as never;
    },
  };
  const cache = new ObjectCache({ k8s: () => counting, idleMs: 100, now: () => now });
  assert.deepEqual(await cache.list(RESOURCES.jobs), []);
  assert.equal((await cache.list(RESOURCES.pods)).length, 1);
  now = 50;
  cache.sweep();
  assert.equal(stopped, 0);
  now = 500;
  cache.sweep();
  assert.equal(stopped, 1);
});

test("closing a followed log stops the stream on the API server", async () => {
  let stopped = 0;
  const sink: { emit?: (line: string) => void } = {};
  const fake = createFakeK8s({
    objects: [
      { ref: RESOURCES.namespaces, items: [{ metadata: { name: "apps" }, status: { phase: "Active" } }] },
      { ref: RESOURCES.pods, items: [secretPod] },
    ],
  });
  const following = {
    ...fake,
    async logs(_ns: string, _pod: string, options: { follow?: boolean }, onLine: (line: string) => void) {
      assert.equal(options.follow, true);
      sink.emit = onLine;
      onLine("first");
      return { done: new Promise<void>(() => {}), stop: () => void stopped++ };
    },
  };
  const stoppedCount = () => stopped;
  const local = createMockContext("workloads", { services: { k8s: following } });
  await mod.register(local.ctx);
  const srv = await listen(local.app);
  try {
    const controller = new AbortController();
    const res = await fetch(`${srv.url}/api/workloads/namespaces/apps/pods/app-1/logs/stream`, {
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    sink.emit!("password=x1y2z3");
    while (!text.includes("password")) text += decoder.decode((await reader.read()).value);
    assert.match(text, /data: \{"line":"first"\}/);
    assert.match(text, new RegExp(`data: \\{"line":"password=${MASK.replace(/\*/g, "\\*")}"\\}`));
    controller.abort();
    const end = Date.now() + 2000;
    while (Date.now() < end && stoppedCount() === 0) await new Promise((r) => setTimeout(r, 10));
    assert.equal(stopped, 1);
  } finally {
    await srv.close();
    await local.close();
  }
});

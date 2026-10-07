import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESOURCES } from "../../../src/contracts/k8s.js";
import type { CapabilityReport, KubeObject } from "../../../src/contracts/k8s.js";
import { createMockContext } from "../../../src/contracts/mocks/context.js";
import { createK8sService, type K8sService } from "../../../src/modules/k8s/api.js";
import { connectionHealthProvider } from "../../../src/modules/k8s/health.js";
import mod from "../../../src/modules/k8s/index.js";
import { migrations } from "../../../src/modules/k8s/migrations.js";
import { resolveConnection, type Connection } from "../../../src/modules/k8s/transport.js";
import { fixtureItems, loadFixtureSet, scenarios, startFakeApi, type FakeApi } from "../../support/index.js";
import { listen } from "../../runtime/helpers.js";

const fixtures = loadFixtureSet("synthetic");
const fast = { watchSeconds: [30, 30] as [number, number], backoffMs: [20, 100] as [number, number] };

function connect(api: FakeApi): Connection {
  return { source: "kubeconfig", server: api.url, context: "fake", kubeConfig: api.kubeConfig() };
}

async function eventually(check: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Watches open after watch() returns; wait until the server has one.
const watchesOn = (fake: FakeApi, collection: string) =>
  fake.requests.filter((r) => r.path.startsWith(`${collection}?`) && r.path.includes("watch=1")).length;

let api: FakeApi;
let k8s: K8sService;

before(async () => {
  api = await startFakeApi({ fixtures, absentGroups: ["velero.io"], denied: ["get /nodes/proxy"] });
  const conn = connect(api);
  k8s = createK8sService({ connection: () => conn, timing: fast });
});
after(async () => {
  await k8s.close();
  await api.close();
});

const meta = (extra: Partial<KubeObject["metadata"]>): KubeObject => ({ metadata: { name: "x", ...extra } });
const at = () => new Date("2026-10-07T12:00:00Z");
const names = (items: KubeObject[]) => items.map((o) => o.metadata.name).toSorted();

test("lists core objects and CRDs, with kind and apiVersion filled in", async () => {
  const nodes = await k8s.list(RESOURCES.nodes);
  assert.ok(nodes !== "absent");
  assert.deepEqual(names(nodes), names(fixtureItems(fixtures, RESOURCES.nodes)));
  assert.equal(nodes[0]!.kind, "Node");
  assert.equal(nodes[0]!.apiVersion, "v1");

  for (const ref of [RESOURCES.longhornVolumes, RESOURCES.fleetGitRepos, RESOURCES.certificates]) {
    const items = await k8s.list(ref);
    assert.ok(items !== "absent", ref.plural);
    assert.equal(items.length, fixtureItems(fixtures, ref).length, ref.plural);
    assert.equal(items[0]!.apiVersion, `${ref.group}/${ref.version}`);
  }
});

test("namespace and selectors narrow a list", async () => {
  const pods = await k8s.list(RESOURCES.pods, { namespace: "default" });
  assert.ok(pods !== "absent");
  assert.ok(pods.length > 0 && pods.every((p) => p.metadata.namespace === "default"));
  const onNode = await k8s.list(RESOURCES.pods, { fieldSelector: `spec.nodeName=${scenarios.nodes.ready}` });
  assert.ok(onNode !== "absent" && onNode.length > 0);
  assert.ok(onNode.every((p) => (p.spec as { nodeName?: string }).nodeName === scenarios.nodes.ready));
});

test("an unserved API group is absent, never an error", async () => {
  assert.equal(await k8s.list(RESOURCES.veleroBackups), "absent");
  assert.equal(await k8s.get(RESOURCES.veleroBackups, "x", "velero"), "absent");
  assert.equal(await k8s.watch(RESOURCES.veleroSchedules), "absent");
  // No fixture for secrets: the fake serves no such resource.
  assert.equal(await k8s.list(RESOURCES.secrets), "absent");
});

test("get returns the object, or null when it doesn't exist", async () => {
  const { namespace, name } = scenarios.pods.crashloop;
  const pod = await k8s.get(RESOURCES.pods, name, namespace);
  assert.ok(pod && pod !== "absent");
  assert.equal(pod.metadata.name, name);
  assert.equal(pod.kind, "Pod");
  assert.equal(await k8s.get(RESOURCES.pods, "no-such-pod", namespace), null);
  assert.equal(await k8s.get(RESOURCES.nodes, "no-such-node"), null);
  await assert.rejects(k8s.get(RESOURCES.pods, name), /namespaced/);
});

test("raw reaches kubelet stats through the node proxy; version parses", async () => {
  const summary = (await k8s.raw(`/api/v1/nodes/${scenarios.nodes.ready}/proxy/stats/summary`)) as {
    node?: { nodeName?: string };
  };
  assert.equal(summary.node?.nodeName, scenarios.nodes.ready);
  await assert.rejects(k8s.raw(`/api/v1/nodes/${scenarios.nodes.notReady}/proxy/stats/summary`), /no kubelet summary/);
  const version = await k8s.version();
  assert.match(version.gitVersion, /^v1\./);
});

test("logs stream line by line and honour tailLines", async () => {
  const { namespace, name } = scenarios.pods.crashloop;
  const all: string[] = [];
  const stream = await k8s.logs(namespace, name, {}, (line) => all.push(line));
  await stream.done;
  assert.ok(all.length > 1);
  const tail: string[] = [];
  await (
    await k8s.logs(namespace, name, { tailLines: 1 }, (line) => tail.push(line))
  ).done;
  assert.deepEqual(tail, all.slice(-1));
  await assert.rejects(
    k8s.logs(namespace, "no-such-pod", {}, () => {}),
    /not found/
  );
});

test("access review answers per check; capabilities report what is missing and why", async () => {
  assert.equal(await k8s.can({ verb: "list", group: "", resource: "nodes" }), true);
  assert.equal(await k8s.can({ verb: "get", group: "", resource: "nodes", subresource: "proxy" }), false);
  const report = await k8s.capabilities(true);
  const byId = new Map(report.capabilities.map((c) => [c.id, c]));
  assert.deepEqual(byId.get("core.nodes/proxy"), {
    id: "core.nodes/proxy",
    label: "Kubelet stats",
    check: { verb: "get", group: "", resource: "nodes", subresource: "proxy" },
    allowed: false,
    groupPresent: true,
    needs: "get on nodes/proxy",
  });
  assert.equal(byId.get("longhorn.volumes")?.allowed, true);
  assert.equal(byId.get("velero.backups")?.groupPresent, false);
  assert.equal(byId.get("velero.backups")?.needs, "velero.io installed");
  assert.equal(byId.get("core.pods/log")?.allowed, true);
  // Cached until refreshed.
  assert.equal(await k8s.capabilities(), report);
});

test("ownership: labels from product.json, managed-by detection", () => {
  const labels = k8s.ownedLabels();
  assert.equal(k8s.isOwned(meta({ labels })), true);
  assert.equal(k8s.isOwned(meta({ labels: { "app.kubernetes.io/managed-by": "someone-else" } })), false);
  assert.equal(k8s.isOwned(meta({})), false);
  // Fleet deploys through Helm, so its objects carry both; Fleet wins.
  assert.equal(
    k8s.managedBy(meta({ labels: { "app.kubernetes.io/managed-by": "Helm", "objectset.rio.cattle.io/hash": "abc" } })),
    "fleet"
  );
  assert.equal(k8s.managedBy(meta({ annotations: { "argocd.argoproj.io/tracking-id": "a:b" } })), "argo");
  assert.equal(k8s.managedBy(meta({ annotations: { "meta.helm.sh/release-name": "r" } })), "helm");
  assert.equal(k8s.managedBy(meta({})), null);
});

test("informers: sync, live changes, replay to a second watcher, shared and stopped", async () => {
  const seen: string[] = [];
  const watch = await k8s.watch(
    RESOURCES.namespaces,
    {},
    {
      add: (o) => seen.push(`add ${o.metadata.name}`),
      update: (o, old) => seen.push(`update ${o.metadata.name} ${old.metadata.labels?.v ?? "-"}`),
      delete: (o) => seen.push(`delete ${o.metadata.name}`),
    }
  );
  assert.ok(watch !== "absent");
  await watch.synced;
  const initial = fixtureItems(fixtures, RESOURCES.namespaces).length;
  assert.equal(watch.list().length, initial);
  assert.equal(seen.length, initial);

  api.upsert(RESOURCES.namespaces, { metadata: { name: "scratch-ns" } });
  await eventually(() => seen.includes("add scratch-ns"), "add");
  api.upsert(RESOURCES.namespaces, { metadata: { name: "scratch-ns", labels: { v: "2" } } });
  await eventually(() => seen.includes("update scratch-ns -"), "update");
  assert.equal(watch.list().find((n) => n.metadata.name === "scratch-ns")?.metadata.labels?.v, "2");

  // A second watcher on the same resource shares the informer and gets the cache replayed.
  const replayed: string[] = [];
  const second = await k8s.watch(RESOURCES.namespaces, {}, { add: (o) => replayed.push(o.metadata.name) });
  assert.ok(second !== "absent");
  assert.equal(replayed.length, initial + 1);
  const listCalls = api.requests.filter((r) => r.path === "/api/v1/namespaces").length;
  assert.equal(listCalls, 1);

  api.remove(RESOURCES.namespaces, "scratch-ns");
  await eventually(() => seen.includes("delete scratch-ns"), "delete");
  watch.stop();
  second.stop();
});

test("a dropped watch resumes from its resourceVersion without relisting", async () => {
  const seen: string[] = [];
  const watch = await k8s.watch(RESOURCES.pvs, {}, { add: (o) => seen.push(o.metadata.name) });
  assert.ok(watch !== "absent");
  const lists = () => api.requests.filter((r) => r.path === "/api/v1/persistentvolumes").length;
  const listsBefore = lists();
  await eventually(() => watchesOn(api, "/api/v1/persistentvolumes") === 1, "watch open");
  api.dropWatches();
  api.upsert(RESOURCES.pvs, { metadata: { name: "pv-while-dropped" } });
  await eventually(() => seen.includes("pv-while-dropped"), "event replayed after reconnect");
  assert.equal(watchesOn(api, "/api/v1/persistentvolumes"), 2);
  assert.equal(lists(), listsBefore);
  api.remove(RESOURCES.pvs, "pv-while-dropped");
  watch.stop();
});

test("410 Gone relists and diffs, so missed adds and deletes are delivered", async () => {
  const seen: string[] = [];
  const watch = await k8s.watch(
    RESOURCES.storageClasses,
    {},
    { add: (o) => seen.push(`add ${o.metadata.name}`), delete: (o) => seen.push(`delete ${o.metadata.name}`) }
  );
  assert.ok(watch !== "absent");
  const existing = watch.list()[0]!.metadata.name;
  const lists = () => api.requests.filter((r) => r.path === "/apis/storage.k8s.io/v1/storageclasses").length;
  assert.equal(lists(), 1);

  // Synchronous, so no reconnect can land in between: the watch comes back
  // with a resourceVersion older than the server's history and gets 410.
  await eventually(() => watchesOn(api, "/apis/storage.k8s.io/v1/storageclasses") === 1, "watch open");
  api.dropWatches();
  api.upsert(RESOURCES.storageClasses, { metadata: { name: "sc-added-during-gap" } });
  api.remove(RESOURCES.storageClasses, existing);
  api.expireWatchHistory();

  await eventually(() => lists() === 2, "relist");
  await eventually(
    () => seen.includes("add sc-added-during-gap") && seen.includes(`delete ${existing}`),
    "diffed events"
  );
  assert.ok(!watch.list().some((o) => o.metadata.name === existing));
  watch.stop();
});

test("label-selected informers see only matching objects", async () => {
  const watch = await k8s.watch(RESOURCES.namespaces, { labelSelector: "team=blue" });
  assert.ok(watch !== "absent");
  assert.equal(watch.list().length, 0);
  api.upsert(RESOURCES.namespaces, { metadata: { name: "blue-ns", labels: { team: "blue" } } });
  api.upsert(RESOURCES.namespaces, { metadata: { name: "red-ns", labels: { team: "red" } } });
  await eventually(() => watch.list().length === 1, "selected add");
  assert.equal(watch.list()[0]!.metadata.name, "blue-ns");
  watch.stop();
  api.remove(RESOURCES.namespaces, "blue-ns");
  api.remove(RESOURCES.namespaces, "red-ns");
});

test("watch errors are reported and retried", async () => {
  const errors: Error[] = [];
  const local = await startFakeApi({ fixtures });
  const conn = connect(local);
  const service = createK8sService({ connection: () => conn, timing: fast });
  const watch = await service.watch(RESOURCES.nodes, {}, { error: (err) => errors.push(err) });
  assert.ok(watch !== "absent");
  await local.close();
  await eventually(() => errors.length >= 2, "repeated errors");
  assert.ok(errors.every((e) => e instanceof Error));
  // The cache keeps its last state through the outage.
  assert.equal(watch.list().length, fixtureItems(fixtures, RESOURCES.nodes).length);
  await service.close();
});

test("forbidden reads throw rather than returning absent", async () => {
  const local = await startFakeApi({ fixtures, forbidden: ["longhorn.io"] });
  const conn = connect(local);
  const service = createK8sService({ connection: () => conn, timing: fast });
  await assert.rejects(service.list(RESOURCES.longhornVolumes), /forbidden/);
  await assert.rejects(service.watch(RESOURCES.longhornVolumes), /forbidden/);
  await service.close();
  await local.close();
});

test("connection health: ok, missing reads warn, unreachable is crit, unconfigured is unknown", async () => {
  const [apiCheck, access] = await connectionHealthProvider(k8s, at).collect();
  assert.equal(apiCheck!.status, "ok");
  assert.match(apiCheck!.detail, /^Connected to v1\./);
  assert.equal(access!.status, "warn");
  assert.match(access!.detail, /get on nodes\/proxy/);
  assert.ok(Array.isArray(access!.raw));

  const local = await startFakeApi({ fixtures });
  const conn = connect(local);
  await local.close();
  const down = createK8sService({ connection: () => conn });
  const [unreachable] = await connectionHealthProvider(down, at).collect();
  assert.equal(unreachable!.status, "crit");
  assert.match(unreachable!.detail, /Cannot reach/);

  const none = createK8sService({ connection: () => ({ source: "none" }) });
  const results = await connectionHealthProvider(none, at).collect();
  assert.equal(results.length, 1);
  assert.equal(results[0]!.status, "unknown");
  assert.match(results[0]!.detail, /No Kubernetes connection/);
  const report = await none.capabilities();
  assert.ok(report.capabilities.every((c) => !c.allowed && c.needs === "a Kubernetes connection"));
});

test("resolveConnection: explicit kubeconfig and context, else none without a cluster", () => {
  const file = api.writeKubeconfig();
  const conn = resolveConnection({ kubeconfig: file, env: {}, home: "/nonexistent" });
  assert.equal(conn.source, "kubeconfig");
  assert.equal(conn.server, api.url);
  assert.equal(conn.context, "fake");
  assert.throws(() => resolveConnection({ kubeconfig: file, context: "nope", env: {} }));
  assert.deepEqual(resolveConnection({ env: {}, home: mkdtempSync(join(tmpdir(), "k8s-home-")) }), { source: "none" });

  const home = mkdtempSync(join(tmpdir(), "k8s-home-"));
  mkdirSync(join(home, ".kube"));
  writeFileSync(join(home, ".kube", "config"), api.kubeconfig());
  const fromHome = resolveConnection({ env: {}, home });
  assert.equal(fromHome.source, "kubeconfig");
  assert.equal(fromHome.file, join(home, ".kube", "config"));
});

test("module: provides the service, registers the health provider, serves capabilities", async () => {
  const file = api.writeKubeconfig();
  const mock = createMockContext("k8s", { migrations, settings: { "k8s.kubeconfig": file } });
  await mod.register(mock.ctx);
  const service = mock.ctx.services.get("k8s");
  const nodes = await service.list(RESOURCES.nodes);
  assert.ok(nodes !== "absent" && nodes.length > 0);
  assert.deepEqual(
    mock.ctx.health.list().map((p) => [p.id, p.category]),
    [["k8s", "cluster"]]
  );

  const server = await listen(mock.app);
  try {
    const res = await fetch(`${server.url}/api/k8s/capabilities?refresh=1`);
    assert.equal(res.status, 200);
    const report = (await res.json()) as CapabilityReport;
    assert.equal(report.capabilities.find((c) => c.id === "core.nodes/proxy")?.allowed, false);
    assert.equal(report.capabilities.find((c) => c.id === "core.nodes")?.allowed, true);
  } finally {
    await server.close();
    await (service as K8sService).close();
    await mock.close();
  }
});

test("connection health: a denied opt-in grant is off, not missing", async () => {
  const local = await startFakeApi({ fixtures, denied: ["list /secrets"] });
  const conn = connect(local);
  const service = createK8sService({ connection: () => conn, timing: fast });
  const [, access] = await connectionHealthProvider(service, at).collect();
  assert.equal(access!.status, "ok");
  assert.match(access!.detail, /reads granted; off by chart default: Secret$/);
  assert.equal(access!.raw, undefined);

  const both = await startFakeApi({ fixtures, denied: ["list /secrets", "get /nodes/proxy"] });
  const bothConn = connect(both);
  const bothService = createK8sService({ connection: () => bothConn, timing: fast });
  const [, warned] = await connectionHealthProvider(bothService, at).collect();
  assert.equal(warned!.status, "warn");
  assert.equal(warned!.value, 1);
  assert.match(warned!.detail, /^Missing 1 read: get on nodes\/proxy; off by chart default: Secret$/);
  await service.close();
  await bothService.close();
  await local.close();
  await both.close();
});

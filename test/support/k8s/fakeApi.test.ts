import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthorizationV1Api,
  CoreV1Api,
  CustomObjectsApi,
  makeInformer,
  type V1Node,
  type V1Pod,
} from "@kubernetes/client-node";
import { RESOURCES, type KubeObject, type ResourceRef } from "../../../src/contracts/k8s.js";
import { fixtureItems, loadFixtureSet } from "./fixtures.js";
import { startFakeApi, type FakeApi } from "./fakeApi.js";
import { scenarios } from "./synthetic.js";

const fixtures = loadFixtureSet("synthetic");
let api: FakeApi;

before(async () => {
  api = await startFakeApi({ fixtures });
});
after(() => api.close());

const crd = (ref: ResourceRef) => ({ group: ref.group, version: ref.version, plural: ref.plural });

// Every list in the set comes back through client-node, with the right count.
test("every fixture list loads through a client-node list call", async () => {
  const core = api.kubeConfig().makeApiClient(CoreV1Api);
  const custom = api.kubeConfig().makeApiClient(CustomObjectsApi);
  const counts: Record<string, number> = {
    namespaces: (await core.listNamespace()).items.length,
    nodes: (await core.listNode()).items.length,
    pods: (await core.listPodForAllNamespaces()).items.length,
    events: (await core.listEventForAllNamespaces()).items.length,
    persistentvolumeclaims: (await core.listPersistentVolumeClaimForAllNamespaces()).items.length,
    persistentvolumes: (await core.listPersistentVolume()).items.length,
  };
  for (const [plural, count] of Object.entries(counts)) {
    assert.equal(
      count,
      fixtureItems(
        fixtures,
        Object.values<ResourceRef>(RESOURCES).find((r) => r.plural === plural && !r.group)!
      ).length,
      plural
    );
  }
  const crds = Object.values<ResourceRef>(RESOURCES).filter((r) => r.group && fixtureItems(fixtures, r).length);
  assert.ok(crds.length >= 15);
  for (const ref of crds) {
    const result = (await custom.listClusterCustomObject(crd(ref))) as { items: KubeObject[] };
    assert.equal(result.items.length, fixtureItems(fixtures, ref).length, `${ref.group}/${ref.plural}`);
  }
});

test("namespaced lists, gets, and label and field selectors", async () => {
  const core = api.kubeConfig().makeApiClient(CoreV1Api);
  const media = await core.listNamespacedPod({ namespace: "media" });
  assert.deepEqual(
    media.items.map((p) => p.metadata?.name),
    ["jellyfin-0"]
  );
  const web = await core.listNamespacedPod({ namespace: "default", labelSelector: "app=web" });
  assert.equal(web.items.length, 2);
  const onNode = await core.listPodForAllNamespaces({ fieldSelector: "spec.nodeName=cp-1,status.phase=Running" });
  assert.ok(onNode.items.length > 0 && onNode.items.every((p) => p.spec?.nodeName === "cp-1"));
  const one = await core.readNode({ name: scenarios.nodes.notReady });
  assert.equal(one.status?.conditions?.find((c) => c.type === "Ready")?.status, "Unknown");
  await assert.rejects(core.readNode({ name: "nope" }), (err: any) => err.code === 404);
});

test("lists omit item kind like a real API server, gets keep it", async () => {
  const body = (await (await fetch(`${api.url}/api/v1/nodes`)).json()) as any;
  assert.equal(body.kind, "NodeList");
  assert.equal(body.items[0].kind, undefined);
  const one = (await (await fetch(`${api.url}/api/v1/nodes/cp-1`)).json()) as any;
  assert.equal(one.kind, "Node");
});

test("discovery serves groups and resource lists", async () => {
  const groups = (await (await fetch(`${api.url}/apis`)).json()) as any;
  assert.ok(groups.groups.some((g: any) => g.name === "longhorn.io"));
  const lh = (await (await fetch(`${api.url}/apis/longhorn.io/v1beta2`)).json()) as any;
  assert.ok(lh.resources.some((r: any) => r.name === "volumes" && r.kind === "Volume" && r.namespaced));
  const version = (await (await fetch(`${api.url}/version`)).json()) as any;
  assert.equal(version.gitVersion, "v1.31.4+k3s1");
});

test("pod logs and kubelet stats through the node proxy", async () => {
  const core = api.kubeConfig().makeApiClient(CoreV1Api);
  const { namespace, name } = scenarios.pods.crashloop;
  const log = await core.readNamespacedPodLog({ namespace, name, tailLines: 2 });
  assert.match(log, /FATAL exiting/);
  assert.equal(log.trim().split("\n").length, 2);
  const summary = (await (await fetch(`${api.url}/api/v1/nodes/worker-1/proxy/stats/summary`)).json()) as any;
  assert.ok(summary.pods.some((p: any) => p.volume?.[0]?.pvcRef?.name === "media-library"));
});

test("absent groups answer 404 and drop out of discovery", async () => {
  const bare = await startFakeApi({ fixtures, absentGroups: ["velero.io"] });
  try {
    const custom = bare.kubeConfig().makeApiClient(CustomObjectsApi);
    await assert.rejects(custom.listClusterCustomObject(crd(RESOURCES.veleroBackups)), (err: any) => err.code === 404);
    const groups = (await (await fetch(`${bare.url}/apis`)).json()) as any;
    assert.ok(!groups.groups.some((g: any) => g.name === "velero.io"));
    assert.equal((await fetch(`${bare.url}/apis/velero.io/v1`)).status, 404);
    assert.ok(((await custom.listClusterCustomObject(crd(RESOURCES.longhornVolumes))) as any).items.length);
  } finally {
    await bare.close();
  }
});

test("forbidden resources answer 403, access reviews follow denied", async () => {
  const locked = await startFakeApi({
    fixtures,
    forbidden: ["/pods"],
    denied: ["get /nodes/proxy", "list velero.io/backups"],
  });
  try {
    const core = locked.kubeConfig().makeApiClient(CoreV1Api);
    await assert.rejects(core.listPodForAllNamespaces(), (err: any) => err.code === 403);
    const authz = locked.kubeConfig().makeApiClient(AuthorizationV1Api);
    const review = (verb: string, group: string, resource: string, subresource?: string) =>
      authz.createSelfSubjectAccessReview({
        body: { spec: { resourceAttributes: { verb, group, resource, subresource } } },
      });
    assert.equal((await review("list", "", "nodes")).status?.allowed, true);
    assert.equal((await review("get", "", "nodes", "proxy")).status?.allowed, false);
    assert.equal((await review("list", "velero.io", "backups")).status?.allowed, false);
  } finally {
    await locked.close();
  }
});

test("the API is read-only", async () => {
  const res = await fetch(`${api.url}/api/v1/namespaces/default/pods`, { method: "POST", body: "{}" });
  assert.equal(res.status, 405);
  assert.equal((await fetch(`${api.url}/api/v1/nodes/cp-1`, { method: "DELETE" })).status, 405);
});

test("a bearer token is enforced when configured", async () => {
  const guarded = await startFakeApi({ fixtures, token: "s3cret" });
  try {
    assert.equal((await fetch(`${guarded.url}/version`)).status, 401);
    const core = guarded.kubeConfig().makeApiClient(CoreV1Api);
    assert.ok((await core.listNode()).items.length);
  } finally {
    await guarded.close();
  }
});

async function waitFor(check: () => boolean, what: string) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("an informer syncs, sees upserts and deletes, and recovers from a dropped watch and a 410", async () => {
  const live = await startFakeApi({ fixtures });
  const config = live.kubeConfig();
  const core = config.makeApiClient(CoreV1Api);
  const informer = makeInformer<V1Node>(config, "/api/v1/nodes", () => core.listNode());
  const seen: string[] = [];
  informer.on("add", (n) => seen.push(`add ${n.metadata?.name}`));
  informer.on("update", (n) => seen.push(`update ${n.metadata?.name}`));
  informer.on("delete", (n) => seen.push(`delete ${n.metadata?.name}`));
  try {
    await informer.start();
    assert.equal(informer.list().length, 3);

    const worker = fixtureItems(fixtures, RESOURCES.nodes).find((n) => n.metadata.name === "worker-1")!;
    live.upsert(RESOURCES.nodes, {
      ...worker,
      metadata: { ...worker.metadata, labels: { ...worker.metadata.labels, touched: "1" } },
    });
    await waitFor(() => seen.includes("update worker-1"), "update event");

    live.upsert(RESOURCES.nodes, { apiVersion: "v1", kind: "Node", metadata: { name: "worker-3" } });
    await waitFor(() => seen.includes("add worker-3"), "add event");

    live.dropWatches();
    live.remove(RESOURCES.nodes, "worker-3");
    await waitFor(() => seen.includes("delete worker-3"), "delete after reconnect");

    live.expireWatchHistory();
    live.dropWatches();
    live.upsert(RESOURCES.nodes, { apiVersion: "v1", kind: "Node", metadata: { name: "worker-4" } });
    await waitFor(() => informer.list().some((n) => n.metadata?.name === "worker-4"), "relist after 410");
  } finally {
    await informer.stop();
    await live.close();
  }
});

test("a namespace-scoped informer only sees its namespace", async () => {
  const live = await startFakeApi({ fixtures });
  const config = live.kubeConfig();
  const core = config.makeApiClient(CoreV1Api);
  const informer = makeInformer<V1Pod>(config, "/api/v1/namespaces/media/pods", () =>
    core.listNamespacedPod({ namespace: "media" })
  );
  try {
    await informer.start();
    assert.deepEqual(
      informer.list().map((p) => p.metadata?.name),
      ["jellyfin-0"]
    );
    const other = fixtureItems(fixtures, RESOURCES.pods)[0]!;
    live.upsert(RESOURCES.pods, { ...other, metadata: { ...other.metadata, labels: { x: "1" } } });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(informer.list().length, 1);
  } finally {
    await informer.stop();
    await live.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { apiMocks, mockPosture } from "../../src/contracts/mocks/api.js";
import {
  mockAbsentSource,
  mockCapacitySource,
  mockProtectedVolumes,
  mockTargets,
  mockUnprotectedPvcs,
} from "../../src/contracts/mocks/backups.js";
import {
  createMockCatalogService,
  mockBlockedPlan,
  mockCatalog,
  mockCatalogApps,
  mockDeployDisabled,
  mockDeployPlan,
  mockDiscovery,
  mockHostKeypair,
} from "../../src/contracts/mocks/catalog.js";
import { mockCheckResults } from "../../src/contracts/mocks/health.js";
import { createFakeK8s, mockClusterObjects, mockLonghornObjects } from "../../src/contracts/mocks/k8s.js";
import { mockSeries } from "../../src/contracts/mocks/metrics.js";
import { MOCK_NOW } from "../../src/contracts/mocks/time.js";
import { RESOURCES, type KubeObject } from "../../src/contracts/k8s.js";
import { STATUS_SEVERITY } from "../../src/contracts/health.js";

test("there is a check result in every status", () => {
  assert.deepEqual(Object.keys(mockCheckResults).toSorted(), [...STATUS_SEVERITY].toSorted());
});

test("backup mocks cover protected, stale, failing, never-run and unprotected", () => {
  const states = mockPosture.rows.map((row) => row.ageDetail);
  assert.equal(mockPosture.rows.filter((row) => !row.protected).length, mockUnprotectedPvcs.length);
  assert.ok(mockProtectedVolumes.some((v) => v.lastAttempt?.ok === false));
  assert.ok(mockProtectedVolumes.some((v) => !v.lastGood));
  assert.ok(mockProtectedVolumes.some((v) => v.restoreEvidence));
  assert.ok(states.some((s) => /days old/.test(s)));
  assert.equal(mockPosture.rows[0]!.protected, false, "unprotected rows sort first");
});

test("absent source and capacity source behave", async () => {
  assert.equal(await mockAbsentSource.list(), "absent");
  assert.equal(mockCapacitySource.targetMatch(mockTargets.nas), true);
  assert.equal(mockCapacitySource.targetMatch(mockTargets.s3), false);
});

test("series mocks are deterministic and fan out by node", () => {
  const query = { series: "node.cpu.percent", from: MOCK_NOW - 3_600_000, to: MOCK_NOW, stepMs: 60_000 };
  const a = mockSeries(query);
  assert.equal(a.length, 3);
  assert.deepEqual(a, mockSeries(query));
  assert.equal(a[0]!.points.length, 61);
});

test("fake k8s lists, filters, watches and reports absent groups", async () => {
  const k8s = createFakeK8s({ objects: mockClusterObjects(), absentGroups: ["velero.io"] });
  assert.equal(await k8s.list(RESOURCES.veleroBackups), "absent");
  const nodes = (await k8s.list(RESOURCES.nodes)) as KubeObject[];
  assert.equal(nodes.length, 3);
  const media = (await k8s.list(RESOURCES.pods, { namespace: "media" })) as KubeObject[];
  assert.deepEqual(
    media.map((p) => p.metadata.name),
    ["jellyfin-7c9d8"]
  );

  const events: string[] = [];
  const watch = await k8s.watch(RESOURCES.nodes, {}, { add: (n) => events.push(`add ${n.metadata.name}`) });
  assert.notEqual(watch, "absent");
  k8s.upsert(RESOURCES.nodes, { metadata: { name: "node-4" } });
  assert.equal(events.length, 4);
  assert.equal(watch === "absent" ? 0 : watch.list().length, 4);

  const owned = { metadata: { name: "x", labels: k8s.ownedLabels() } };
  assert.equal(k8s.isOwned(owned), true);
  assert.equal(k8s.isOwned({ metadata: { name: "y" } }), false);
  assert.equal(k8s.managedBy({ metadata: { name: "z", labels: { "app.kubernetes.io/managed-by": "Helm" } } }), "helm");
});

test("mock Longhorn objects list through the fake under their own resources", async () => {
  const k8s = createFakeK8s({ objects: [...mockClusterObjects(), ...mockLonghornObjects()] });
  const nodes = (await k8s.list(RESOURCES.longhornNodes)) as KubeObject[];
  assert.equal(nodes.length, 3);
  const replicas = (await k8s.list(RESOURCES.longhornReplicas, {
    labelSelector: "longhornvolume=pvc-11111111-0000-4000-8000-000000000001",
  })) as KubeObject[];
  assert.deepEqual(
    replicas.map((r) => (r.status as { currentState: string }).currentState),
    ["running", "error"]
  );
  assert.equal(((await k8s.list(RESOURCES.longhornSnapshots)) as KubeObject[]).length, 2);
  // Longhorn's Node shares a plural with core's; they stay separate resources.
  assert.equal(((await k8s.list(RESOURCES.nodes)) as KubeObject[]).length, 3);
  assert.equal(
    ((await k8s.list(RESOURCES.nodes)) as KubeObject[]).every((n) => n.apiVersion === "v1"),
    true
  );
});

test("fake k8s reports the API server and its certificate", async () => {
  const info = await createFakeK8s().serverInfo?.();
  assert.equal(info?.host, "10.0.0.10");
  assert.ok(info?.certificate && Date.parse(info.certificate.notAfter) > 0);
});

test("fake k8s marks the Secret capability opt-in and nothing else", async () => {
  const { capabilities } = await createFakeK8s({ denied: ["list /secrets"] }).capabilities();
  assert.deepEqual(
    capabilities.filter((c) => c.optIn).map((c) => [c.id, c.allowed]),
    [["secrets", false]]
  );
});

// Completeness is enforced by the ApiMocks type; this checks the keys are
// well-formed route keys that the route binder will accept.
test("every API mock is keyed by a route", () => {
  for (const key of Object.keys(apiMocks)) assert.match(key, /^(GET|POST|PUT|PATCH|DELETE) \//);
});

test("catalog mocks are consistent: unique ids, known requires, one app per link key", () => {
  const ids = mockCatalog.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of mockCatalog) {
    for (const required of entry.requires) assert.ok(ids.includes(required), `${entry.id} requires ${required}`);
    const keys = entry.inputs.map((input) => input.key);
    assert.equal(new Set(keys).size, keys.length, `${entry.id} input keys`);
    if (entry.exposesUi) assert.ok(keys.includes("host"), `${entry.id} exposes a UI, so it asks for a host`);
  }
  const linkKeys = mockCatalog.flatMap((entry) => (entry.linkKey ? [entry.linkKey] : []));
  assert.deepEqual(linkKeys.toSorted(), ["gitea", "grafana", "headlamp", "longhorn", "rancher"]);
  for (const slot of ["links", "sign-in", "cluster-basics", "backups", "notifications", "remote-access"] as const)
    assert.ok(
      mockCatalog.some((entry) => entry.slots.includes(slot)),
      `an app for ${slot}`
    );
});

test("discovery mocks cover every detect state and every cluster basic, all pointing at catalog apps", () => {
  const ids = new Set(mockCatalog.map((entry) => entry.id));
  assert.deepEqual(
    new Set(mockDiscovery.apps.map((app) => app.state)),
    new Set(["installed", "not-installed", "unknown"])
  );
  assert.equal(mockDiscovery.apps.length, mockCatalog.length);
  for (const host of mockDiscovery.ingressHosts) if (host.appId) assert.ok(ids.has(host.appId));
  assert.deepEqual(mockDiscovery.basics.map((basic) => basic.id).toSorted(), [
    "cert-manager",
    "default-storage-class",
    "ingress-controller",
    "metrics-server",
  ]);
  for (const basic of mockDiscovery.basics) for (const fix of basic.fixAppIds) assert.ok(ids.has(fix));
  assert.ok(mockCatalogApps.every((app) => app.detected.appId === app.id));
});

test("mock catalog service resolves entries and returns a copy of discovery", async () => {
  const catalog = createMockCatalogService();
  assert.equal(catalog.get("grafana")?.linkKey, "grafana");
  assert.equal(catalog.get("nope"), undefined);
  const report = await catalog.discover();
  report.apps.length = 0;
  assert.equal((await catalog.discover()).apps.length, mockCatalog.length);
});

test("deploy mocks: plans mask secrets, jobs cover running, succeeded and failed", () => {
  assert.equal(mockDeployPlan.allowed, true);
  assert.equal(mockBlockedPlan.allowed, false);
  assert.ok(mockBlockedPlan.blockedBy);
  assert.equal(mockBlockedPlan.inputs.bootstrapPassword, "********");
  const states = apiMocks["GET /api/deploy/jobs"].map((job) => job.state);
  assert.deepEqual(states.toSorted(), ["failed", "running", "succeeded"]);
  assert.equal(mockDeployDisabled.enabled, false);
  assert.ok(mockDeployDisabled.enableHint);
  assert.ok(mockHostKeypair.installCommand.includes(mockHostKeypair.publicKey));
});

test("fake k8s create labels the object as owned, refuses duplicates and records writes", async () => {
  const k8s = createFakeK8s({ denied: ["create /secrets"] });
  const job = await k8s.create!(RESOURCES.jobs, { metadata: { name: "deploy-x-1", namespace: "console" } });
  assert.equal(k8s.isOwned(job), true);
  assert.equal(((await k8s.list(RESOURCES.jobs)) as KubeObject[]).length, 1);
  await assert.rejects(
    k8s.create!(RESOURCES.jobs, { metadata: { name: "deploy-x-1", namespace: "console" } }),
    /exists/
  );
  await assert.rejects(k8s.create!(RESOURCES.secrets, { metadata: { name: "v", namespace: "console" } }), /forbidden/);
  await k8s.delete!(RESOURCES.jobs, "deploy-x-1", "console");
  await k8s.delete!(RESOURCES.jobs, "missing", "console");
  assert.equal(((await k8s.list(RESOURCES.jobs)) as KubeObject[]).length, 0);
  assert.deepEqual(
    k8s.writes.map((w) => `${w.verb} ${w.name}`),
    ["create deploy-x-1", "delete deploy-x-1", "delete missing"]
  );
});

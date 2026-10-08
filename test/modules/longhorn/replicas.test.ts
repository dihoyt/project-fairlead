import { test } from "node:test";
import assert from "node:assert/strict";
import type { LonghornReplicaAdvice } from "../../../src/contracts/backups.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { createMockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import mod from "../../../src/modules/longhorn/index.js";
import type { LonghornNode, LonghornVolume, Snapshot } from "../../../src/modules/longhorn/model.js";
import {
  replicaAdvice,
  replicaCount,
  replicaResult,
  type StorageClassObject,
} from "../../../src/modules/longhorn/replicas.js";
import { listen } from "../../runtime/helpers.js";

const AT = new Date(MOCK_NOW).toISOString();

function node(name: string, ready = true, allowScheduling = true): LonghornNode {
  return {
    apiVersion: "longhorn.io/v1beta2",
    kind: "Node",
    metadata: { name, namespace: "longhorn-system" },
    spec: { allowScheduling },
    status: { conditions: [{ type: "Ready", status: ready ? "True" : "False" }] },
  };
}

function volume(name: string, replicas: number, pvc?: string): LonghornVolume {
  return {
    apiVersion: "longhorn.io/v1beta2",
    kind: "Volume",
    metadata: { name, namespace: "longhorn-system" },
    spec: { numberOfReplicas: replicas },
    ...(pvc ? { status: { kubernetesStatus: { namespace: "apps", pvcName: pvc } } } : {}),
  };
}

const setting = (value: string): KubeObject & { value: string } => ({
  apiVersion: "longhorn.io/v1beta2",
  kind: "Setting",
  metadata: { name: "default-replica-count", namespace: "longhorn-system" },
  value,
});

const sc = (name: string, replicas?: string, provisioner = "driver.longhorn.io"): StorageClassObject => ({
  apiVersion: "storage.k8s.io/v1",
  kind: "StorageClass",
  metadata: { name },
  provisioner,
  ...(replicas ? { parameters: { numberOfReplicas: replicas } } : {}),
});

function snapshot(parts: Partial<Snapshot>): Snapshot {
  return {
    takenAt: MOCK_NOW,
    volumes: [],
    backups: [],
    backupVolumes: [],
    targets: [],
    jobs: [],
    settings: [],
    nodes: [],
    replicas: [],
    snapshots: [],
    pvcUids: new Map(),
    ...parts,
  };
}

test("replicaCount reads plain and per-engine values", () => {
  assert.equal(replicaCount("2"), 2);
  assert.equal(replicaCount(3), 3);
  assert.equal(replicaCount('{"v1":"1","v2":"3"}'), 1);
  assert.equal(replicaCount("{bad"), undefined);
  assert.equal(replicaCount("0"), undefined);
});

test("advice: a second node puts single-replica volumes, the Setting and the StorageClass below target", () => {
  const advice = replicaAdvice(
    snapshot({
      nodes: [node("n1"), node("n2"), node("n3", false), node("n4", true, false)],
      volumes: [volume("pvc-b", 1, "data"), volume("pvc-a", 1), volume("pvc-c", 2), volume("pvc-d", 3)],
      settings: [setting('{"v1":"1","v2":"1"}')],
    }),
    [sc("longhorn", "1"), sc("longhorn-fast", "2"), sc("local-path", "1", "rancher.io/local-path"), sc("lh-x")],
    AT
  );
  assert.deepEqual(advice, {
    state: "raise",
    schedulableNodes: 2,
    target: 2,
    defaultReplicaCount: 1,
    storageClasses: [{ name: "longhorn", replicas: 1 }],
    volumes: [
      { name: "pvc-a", replicas: 1 },
      { name: "pvc-b", replicas: 1, pvc: { namespace: "apps", name: "data" } },
    ],
    detail: "2 volumes have 1 replica; 2 nodes can hold 2.",
    checkedAt: AT,
  } satisfies LonghornReplicaAdvice);
  const result = replicaResult(advice, AT);
  assert.equal(result.status, "warn");
  assert.match(result.detail, /Raise it from the Nodes page/);
  assert.ok(result.raw);
});

test("advice: only the Setting below target; ok at target; one node never asks; absent and unreadable", () => {
  const two = [node("n1"), node("n2")];
  const settingOnly = replicaAdvice(snapshot({ nodes: two, settings: [setting("1")] }), [], AT);
  assert.equal(settingOnly.state, "raise");
  assert.equal(settingOnly.detail, "New volumes get 1 replica; 2 nodes can hold 2.");

  const ok = replicaAdvice(snapshot({ nodes: two, settings: [setting("2")], volumes: [volume("v", 2)] }), [], AT);
  assert.equal(ok.state, "ok");
  assert.equal(ok.detail, "Every volume has 2 or more replicas across 2 nodes.");
  assert.equal(replicaResult(ok, AT).status, "ok");

  const single = replicaAdvice(
    snapshot({ nodes: [node("n1")], volumes: [volume("v", 1)], settings: [setting("1")] }),
    [],
    AT
  );
  assert.equal(single.state, "ok");
  assert.equal(single.target, 1);
  assert.deepEqual(single.volumes, []);
  assert.equal(single.detail, "1 schedulable node: 1 replica is all it can hold.");

  assert.equal(replicaAdvice("absent", [], AT).state, "absent");
  const unreadable = replicaAdvice(snapshot({ nodes: { error: "forbidden" } }), [], AT);
  assert.equal(unreadable.state, "unknown");
  assert.equal(unreadable.error, "forbidden");
  assert.equal(replicaResult(unreadable, AT).status, "unknown");
});

test("GET /api/longhorn/replicas reads the cluster; the storage provider adds the replica check", async () => {
  const k8s = createFakeK8s({
    objects: [
      { ref: RESOURCES.longhornVolumes, items: [volume("pvc-a", 1)] },
      { ref: RESOURCES.longhornNodes, items: [node("n1"), node("n2")] },
      { ref: RESOURCES.longhornSettings, items: [setting("1")] },
      { ref: RESOURCES.storageClasses, items: [sc("longhorn", "1")] },
    ],
  });
  const mock = createMockContext("longhorn", { migrations: mod.migrations, services: { k8s } });
  await mod.register(mock.ctx);
  const server = await listen(mock.app);
  try {
    const advice = (await (await fetch(`${server.url}/api/longhorn/replicas`)).json()) as LonghornReplicaAdvice;
    assert.equal(advice.state, "raise");
    assert.deepEqual(advice.storageClasses, [{ name: "longhorn", replicas: 1 }]);
    assert.deepEqual(advice.volumes, [{ name: "pvc-a", replicas: 1 }]);

    const storage = mock.ctx.health.list().find((p) => p.id === "longhorn")!;
    const check = (await storage.collect()).find((r) => r.id === "replica-target");
    assert.equal(check?.status, "warn");
  } finally {
    await server.close();
    await mock.close();
  }
});

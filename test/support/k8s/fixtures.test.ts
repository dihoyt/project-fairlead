import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RESOURCES, type ResourceRef } from "../../../src/contracts/k8s.js";
import { fixtureItems, listFixtureSets, loadFixtureSet } from "./fixtures.js";
import { buildSyntheticSet, renderFixtureFile, scenarios } from "./synthetic.js";

test("the committed synthetic set is what the generator produces", async () => {
  const dir = loadFixtureSet("synthetic").dir;
  for (const [file, body] of Object.entries(buildSyntheticSet())) {
    const expected = await renderFixtureFile(join(dir, file), body);
    assert.equal(
      readFileSync(join(dir, file), "utf8"),
      expected,
      `${file} is stale: run node --import tsx test/support/k8s/writeSynthetic.ts`
    );
  }
});

test("every set loads and every list maps to a known resource", () => {
  assert.ok(listFixtureSets().includes("synthetic"));
  const set = loadFixtureSet("synthetic");
  const known = new Set(Object.values<ResourceRef>(RESOURCES).map((r) => `${r.group}/${r.plural}`));
  // Captured and served, but with no entry in the K8sApi contract's RESOURCES yet.
  const awaitingContract = new Set(["longhorn.io/nodes", "longhorn.io/replicas", "longhorn.io/snapshots"]);
  for (const { ref, items } of set.lists) {
    const key = `${ref.group}/${ref.plural}`;
    assert.ok(known.has(key) || awaitingContract.has(key), `${key} is not in RESOURCES`);
    assert.ok(items.length > 0, `${ref.plural} is empty`);
  }
  assert.deepEqual(Object.keys(set.kubelet).toSorted(), ["cp-1", "worker-1"]);
});

test("the synthetic set covers each state the providers must tell apart", () => {
  const set = loadFixtureSet("synthetic");
  const states = (ref: ResourceRef, pick: (o: any) => unknown) => new Set(fixtureItems(set, ref).map(pick));
  assert.deepEqual(
    states(RESOURCES.longhornVolumes, (o) => o.status.robustness),
    new Set(["healthy", "degraded", "faulted", "unknown"])
  );
  assert.deepEqual(
    states(RESOURCES.longhornBackups, (o) => o.status.state),
    new Set(["Completed", "Error"])
  );
  assert.deepEqual(
    states(RESOURCES.longhornBackupTargets, (o) => o.status.available),
    new Set([true, false])
  );
  assert.deepEqual(
    states(RESOURCES.veleroBackups, (o) => o.status.phase),
    new Set(["Completed", "PartiallyFailed", "Failed"])
  );
  assert.deepEqual(
    states(RESOURCES.veleroBackupStorageLocations, (o) => o.status.phase),
    new Set(["Available", "Unavailable"])
  );
  assert.deepEqual(
    states(RESOURCES.fleetGitRepos, (o) => o.status.display.state),
    new Set(["Ready", "NotReady"])
  );
  assert.deepEqual(
    states(RESOURCES.fleetBundles, (o) => o.status.display.state),
    new Set(["Ready", "NotReady"])
  );
  assert.deepEqual(
    states(RESOURCES.certificates, (o) => o.status.conditions[0].status),
    new Set(["True", "False"])
  );
  const lhItems = (plural: string) =>
    fixtureItems(set, { group: "longhorn.io", version: "v1beta2", plural, kind: "", namespaced: true }) as any[];
  const lowDisks = lhItems("nodes")
    .flatMap((n) => Object.values<any>(n.status.diskStatus))
    .filter(
      (d) =>
        (d.storageAvailable / d.storageMaximum) * 100 <
        Number(lhItems("settings").find((x) => x.metadata.name === "storage-minimal-available-percentage").value)
    );
  assert.equal(lowDisks.length, 1);
  const degradedReplicas = lhItems("replicas").filter((r) => r.spec.volumeName === scenarios.longhorn.degraded);
  assert.equal(degradedReplicas.length, 2);
  assert.equal(degradedReplicas.filter((r) => r.status.currentState === "running").length, 1);
  assert.deepEqual(lhItems("snapshots").filter((x) => x.status.error).length, 1);
  const podStates = [...states(RESOURCES.pods, (o) => o.status.phase)];
  assert.ok(["Running", "Pending", "Succeeded"].every((p) => podStates.includes(p)));
  assert.ok(
    fixtureItems(set, RESOURCES.pods).some(
      (p: any) => p.status.containerStatuses?.[0]?.state?.waiting?.reason === "CrashLoopBackOff"
    )
  );
  assert.ok(fixtureItems(set, RESOURCES.events).some((e: any) => e.reason === "FailedScheduling"));
});

test("fixtures carry no env values, commands or credentials, as capture strips them", () => {
  const text = JSON.stringify(buildSyntheticSet());
  for (const pod of fixtureItems(loadFixtureSet("synthetic"), RESOURCES.pods) as any[]) {
    for (const c of pod.spec.containers) {
      assert.deepEqual(c.command, ["REDACTED"]);
      assert.ok(c.env.every((e: any) => e.value === "REDACTED"));
    }
  }
  assert.ok(!/\/\/[^/@\s"]+:[^/@\s"]+@/.test(text), "URL credentials present");
});

test("every object has a distinct uid", () => {
  const seen = new Map<string, string>();
  for (const { ref, items } of loadFixtureSet("synthetic").lists) {
    for (const { metadata } of items) {
      if (!metadata.uid) continue;
      const who = `${ref.plural} ${metadata.namespace ?? ""}/${metadata.name}`;
      assert.equal(seen.get(metadata.uid), undefined, `${who} shares a uid with ${seen.get(metadata.uid)}`);
      seen.set(metadata.uid, who);
    }
  }
});

test("owner references and kubelet pod refs point at real uids", () => {
  const set = loadFixtureSet("synthetic");
  const uids = new Set(set.lists.flatMap((l) => l.items.map((o) => o.metadata.uid)));
  // uploads-api's ReplicaSet is left out on purpose: workload and backup tests use it as the orphan case.
  const orphans = new Set(["ReplicaSet/uploads-api-5c6d8f7b9"]);
  for (const { items } of set.lists) {
    for (const o of items) {
      for (const owner of o.metadata.ownerReferences ?? []) {
        if (orphans.has(`${owner.kind}/${owner.name}`)) continue;
        assert.ok(uids.has(owner.uid), `${o.metadata.name} owner ${owner.kind}/${owner.name} has no object`);
      }
    }
  }
  const podUids = new Set(fixtureItems(set, RESOURCES.pods).map((p) => p.metadata.uid));
  for (const summary of Object.values(set.kubelet) as any[]) {
    for (const pod of summary.pods) assert.ok(podUids.has(pod.podRef.uid), `kubelet pod ${pod.podRef.name}`);
  }
});

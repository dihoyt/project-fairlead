import { test } from "node:test";
import assert from "node:assert/strict";
import { RESOURCES } from "../../../src/contracts/k8s.js";
import type { K8sApi, KubeObject, ResourceRef } from "../../../src/contracts/k8s.js";
import type { CheckResult } from "../../../src/contracts/health.js";
import { createMockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s, mockLonghornObjects, type FakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { DAY, HOUR, MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import { longestGapMs, parseCron, previousFires } from "../../../src/modules/longhorn/cron.js";
import {
  BACKUPS_PAGE,
  BACKUPS_PROVIDER_ID,
  STORAGE_PROVIDER_ID,
  createBackupsProvider,
  createStorageProvider,
  type HealthOptions,
} from "../../../src/modules/longhorn/health.js";
import mod from "../../../src/modules/longhorn/index.js";
import { ACTUAL_SERIES, SIZE_SERIES, createCollector } from "../../../src/modules/longhorn/metrics.js";
import { migrations } from "../../../src/modules/longhorn/migrations.js";
import { createLoader, redactUrl, type LonghornVolume } from "../../../src/modules/longhorn/model.js";
import { createBackupSource } from "../../../src/modules/longhorn/source.js";
import { fixtureItems, loadFixtureSet, scenarios } from "../../support/index.js";

const fixtures = loadFixtureSet("synthetic");
const L = scenarios.longhorn;
const P = scenarios.pvcs;
const now = () => MOCK_NOW;
const LONGHORN_REFS: ResourceRef[] = [
  RESOURCES.longhornVolumes,
  RESOURCES.longhornBackups,
  RESOURCES.longhornBackupVolumes,
  RESOURCES.longhornBackupTargets,
  RESOURCES.longhornRecurringJobs,
  RESOURCES.longhornSettings,
  RESOURCES.longhornNodes,
  RESOURCES.longhornReplicas,
  RESOURCES.longhornSnapshots,
  RESOURCES.pvcs,
];

function cluster(options: { absent?: boolean } = {}): FakeK8s {
  return createFakeK8s({
    objects: LONGHORN_REFS.map((ref) => ({ ref, items: fixtureItems(fixtures, ref) })),
    ...(options.absent ? { absentGroups: ["longhorn.io"] } : {}),
  });
}

function setup(k8s: K8sApi = cluster(), overrides: Partial<HealthOptions> = {}) {
  // ttl 0: every collect sees the fake cluster's current objects.
  const load = createLoader(() => k8s, now, 0);
  const options: HealthOptions = { load, now, graceMs: () => 2 * HOUR, uiUrl: () => "", ...overrides };
  return {
    storage: createStorageProvider(options),
    backups: createBackupsProvider(options),
    collector: createCollector(load),
    source: createBackupSource(load, now),
  };
}

const byId = (results: CheckResult[]) => new Map(results.map((r) => [r.id, r]));

function volume(name: string): LonghornVolume {
  const found = fixtureItems(fixtures, RESOURCES.longhornVolumes).find((v) => v.metadata.name === name);
  assert.ok(found, name);
  return structuredClone(found) as LonghornVolume;
}

// --- cron -------------------------------------------------------------------

test("cron: parses fields, macros and names; refuses nonsense", () => {
  assert.ok(parseCron("0 2 * * *"));
  assert.ok(parseCron("@daily"));
  assert.ok(parseCron("*/15 1-5 * jan-mar mon,fri"));
  assert.deepEqual([...parseCron("0 0 * * 7")!.weekdays], [0]);
  for (const bad of ["", "0 2 * *", "61 * * * *", "* * * * mon-sun-x", "*/0 * * * *", "a b c d e"]) {
    assert.equal(parseCron(bad), null, bad);
  }
});

test("cron: previous fires and the longest gap between them", () => {
  const daily = parseCron("0 2 * * *")!;
  assert.deepEqual(
    previousFires(daily, MOCK_NOW, 2).map((t) => new Date(t).toISOString()),
    ["2026-10-07T02:00:00.000Z", "2026-10-06T02:00:00.000Z"]
  );
  assert.equal(longestGapMs(daily, MOCK_NOW), DAY);
  // 2026-10-07 is a Wednesday; the last Sunday 02:30 is 2026-10-04.
  const weekly = parseCron("30 2 * * 0")!;
  assert.equal(new Date(previousFires(weekly, MOCK_NOW, 1)[0]!).toISOString(), "2026-10-04T02:30:00.000Z");
  assert.equal(longestGapMs(weekly, MOCK_NOW), 7 * DAY);
  assert.equal(longestGapMs(parseCron("*/5 * * * *")!, MOCK_NOW), 5 * 60_000);
  // Weekdays only: Friday to Monday is the longest wait.
  assert.equal(longestGapMs(parseCron("0 3 * * 1-5")!, MOCK_NOW), 3 * DAY);
  // Both day fields restricted: either matches (the 1st, or any Monday).
  const either = parseCron("0 0 1 * 1")!;
  const fires = previousFires(either, MOCK_NOW, 3).map((t) => new Date(t).toISOString().slice(0, 10));
  assert.deepEqual(fires, ["2026-10-05", "2026-10-01", "2026-09-28"]);
});

// --- storage health ---------------------------------------------------------

test("storage: healthy, degraded, faulted and detached volumes", async () => {
  const results = byId(await setup().storage.collect());
  assert.equal(results.get(`volume:${L.healthy}`)?.status, "ok");
  assert.equal(results.get(`volume:${L.healthy}`)?.label, `Volume ${P.protected.namespace}/${P.protected.name}`);
  assert.equal(results.get(`volume:${L.degraded}`)?.status, "warn");
  assert.match(results.get(`volume:${L.degraded}`)!.detail, /fewer than 2 healthy replicas/);
  const faulted = results.get(`volume:${L.faulted}`)!;
  assert.equal(faulted.status, "crit");
  assert.match(faulted.detail, /Faulted/);
  assert.match(faulted.detail, /replica scheduling failing \(ReplicaSchedulingFailure\)/);
  assert.ok(faulted.raw, "raw on failure");
  // Longhorn reports a detached volume's robustness as unknown; nothing needs it.
  assert.equal(results.get(`volume:${L.detached}`)?.status, "ok");
  assert.equal(results.get(`volume:${L.detached}`)?.detail, "Detached, not in use");
  assert.equal(results.get(`volume:${L.unprotected}`)?.status, "ok");
  assert.equal(results.get(`volume:${L.healthy}`)?.raw, undefined);
  for (const r of results.values()) assert.ok(r.detail);
});

test("storage: a volume detached under a running pod is critical", async () => {
  const k8s = cluster();
  const v = volume(L.detached);
  v.status!.kubernetesStatus!.workloadsStatus = [
    { podName: "scratch-0", podStatus: "Pending", workloadName: "scratch", workloadType: "StatefulSet" },
  ];
  k8s.upsert(RESOURCES.longhornVolumes, v);
  const result = byId(await setup(k8s).storage.collect()).get(`volume:${L.detached}`)!;
  assert.equal(result.status, "crit");
  assert.match(result.detail, /Detached while scratch-0 \(Pending\) needs it/);
});

test("storage: deep links into the Longhorn UI when configured", async () => {
  const results = byId(await setup(cluster(), { uiUrl: () => "https://longhorn.example.test/" }).storage.collect());
  assert.equal(results.get(`volume:${L.healthy}`)?.deepLink, `https://longhorn.example.test/#/volume/${L.healthy}`);
});

// --- backups health ---------------------------------------------------------

test("backups: target reachability, job schedules and per-volume backup age", async () => {
  const results = byId(await setup().backups.collect());

  assert.equal(results.get("target:default")?.status, "ok");
  const offsite = results.get("target:offsite")!;
  assert.equal(offsite.status, "crit");
  assert.match(offsite.detail, /s3:\/\/offsite-backups@eu-west-1\/longhorn unreachable: .*AccessDenied/);

  // db-backup's latest run (06:00 today) failed, though nothing is overdue.
  assert.equal(results.get("job:db-backup")?.status, "warn");
  assert.match(results.get("job:db-backup")!.detail, /\(Error\)/);
  // media-backup is weekly and missed last Sunday's run.
  assert.equal(results.get("job:media-backup")?.status, "warn");
  assert.equal(results.get("job:media-backup")?.value, 1);
  // Snapshot jobs are reported, not judged.
  assert.equal(results.get("job:hourly-snap")?.status, "ok");

  const healthy = results.get(`backup:${L.healthy}`)!;
  assert.equal(healthy.status, "ok");
  assert.equal(healthy.value, 10);
  assert.match(healthy.detail, /Last good backup 10h ago \(backup-1b2c3d4e5f607182\)/);

  const stale = results.get(`backup:${L.degraded}`)!;
  assert.equal(stale.status, "warn");
  assert.match(stale.detail, /1 scheduled backup missed/);

  const failing = results.get(`backup:${L.faulted}`)!;
  assert.equal(failing.status, "crit");
  assert.match(failing.detail, /3 or more scheduled backups missed/);
  assert.match(failing.detail, /last attempt 6h ago failed: .*connection refused/);
  assert.ok(failing.raw);

  const never = results.get(`backup:${L.detached}`)!;
  assert.equal(never.status, "crit");
  assert.equal(never.value, "never");
  assert.match(never.detail, /Never backed up/);

  assert.equal(results.has(`backup:${L.unprotected}`), false);
  const unprotected = results.get("unprotected")!;
  assert.equal(unprotected.status, "warn");
  assert.equal(unprotected.value, 1);
  assert.match(unprotected.detail, /default\/cache/);
});

test("backups: an unreachable default target is critical", async () => {
  const k8s = cluster();
  const target = fixtureItems(fixtures, RESOURCES.longhornBackupTargets).find((t) => t.metadata.name === "default")!;
  const down = structuredClone(target) as KubeObject & { status: Record<string, unknown> };
  down.status = {
    ...down.status,
    available: false,
    conditions: [
      { type: "Unavailable", status: "True", reason: "BackupTargetError", message: "dial tcp: i/o timeout" },
    ],
  };
  k8s.upsert(RESOURCES.longhornBackupTargets, down);
  const result = byId(await setup(k8s).backups.collect()).get("target:default")!;
  assert.equal(result.status, "crit");
  assert.match(result.detail, /nfs:\/\/nas\.example\.lan:\/volume1\/longhorn unreachable: dial tcp: i\/o timeout/);
});

test("backups: a fresh good backup clears a missed run", async () => {
  const k8s = cluster();
  const backup = structuredClone(
    fixtureItems(fixtures, RESOURCES.longhornBackups).find((b) => b.metadata.name === "backup-0a1b2c3d4e5f6071")!
  ) as KubeObject & { status: Record<string, unknown> };
  backup.metadata.name = "backup-fresh";
  backup.status = { ...backup.status, snapshotCreatedAt: "2026-10-04T02:30:00.000Z" };
  k8s.upsert(RESOURCES.longhornBackups, backup);
  const results = byId(await setup(k8s).backups.collect());
  assert.equal(results.get(`backup:${L.degraded}`)?.status, "ok");
  assert.equal(results.get("job:media-backup")?.status, "ok");
});

test("backups: the default group applies to volumes with no job labels", async () => {
  const k8s = cluster();
  const job = structuredClone(
    fixtureItems(fixtures, RESOURCES.longhornRecurringJobs).find((j) => j.metadata.name === "db-backup")!
  ) as KubeObject & { spec: Record<string, unknown> };
  job.spec = { ...job.spec, groups: ["default"] };
  k8s.upsert(RESOURCES.longhornRecurringJobs, job);
  const results = byId(await setup(k8s).backups.collect());
  assert.equal(results.get("unprotected")?.status, "ok");
  assert.ok(results.has(`backup:${L.unprotected}`));
});

test("backups: falls back to the backup-target setting on Longhorn without BackupTarget objects", async () => {
  const k8s = cluster();
  k8s.set(RESOURCES.longhornBackupTargets, []);
  const results = byId(await setup(k8s).backups.collect());
  const target = results.get("target:default")!;
  assert.equal(target.status, "unknown");
  assert.match(target.detail, /reachability not reported/);
});

test("backups: no target at all points at the console's Backups page", async () => {
  const k8s = cluster();
  k8s.set(RESOURCES.longhornBackupTargets, []);
  k8s.set(RESOURCES.longhornSettings, []);
  const target = byId(await setup(k8s).backups.collect()).get("target")!;
  assert.equal(target.status, "crit");
  assert.match(target.detail, /^No backup target configured: set one on the Backups page$/);
  assert.equal(target.deepLink, BACKUPS_PAGE);
});

// --- absent and failing -----------------------------------------------------

test("absent: Longhorn not installed reads as absent everywhere", async () => {
  const { storage, backups, collector, source } = setup(cluster({ absent: true }));
  for (const provider of [storage, backups]) {
    const results = await provider.collect();
    assert.deepEqual(
      results.map((r) => [r.id, r.status]),
      [["installed", "absent"]]
    );
  }
  assert.deepEqual(await collector.collect(), []);
  assert.equal(await source.list(), "absent");
});

test("a failing API reads as unknown, never a throw", async () => {
  const k8s = cluster();
  const broken: K8sApi = {
    ...k8s,
    list: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  };
  const { storage, backups, collector, source } = setup(broken);
  const s = await storage.collect();
  assert.equal(s[0]?.status, "unknown");
  assert.match(s[0]!.detail, /ECONNREFUSED/);
  assert.equal((await backups.collect())[0]?.status, "unknown");
  assert.deepEqual(await collector.collect(), []);
  await assert.rejects(source.list(), /ECONNREFUSED/);
});

test("the loader shares one read between concurrent callers and caches it", async () => {
  const k8s = cluster();
  let lists = 0;
  const counting: K8sApi = {
    ...k8s,
    list: async (ref, opts) => {
      lists++;
      return k8s.list(ref, opts);
    },
  };
  let clock = MOCK_NOW;
  const load = createLoader(
    () => counting,
    () => clock,
    10_000
  );
  await Promise.all([load(), load(), load()]);
  assert.equal(lists, LONGHORN_REFS.length);
  await load();
  assert.equal(lists, LONGHORN_REFS.length);
  clock += 10_000;
  await load();
  assert.equal(lists, 2 * LONGHORN_REFS.length);
});

// --- backup source ----------------------------------------------------------

test("source: one ProtectedVolume per PVC with a backup job", async () => {
  const list = await setup().source.list();
  assert.ok(list !== "absent");
  assert.deepEqual(
    list.map((v) => `${v.pvc.namespace}/${v.pvc.name}`),
    [P.protected, P.neverRun, P.failing, P.stale].map((p) => `${p.namespace}/${p.name}`)
  );
  const pvcs = fixtureItems(fixtures, RESOURCES.pvcs);
  for (const v of list) {
    assert.equal(v.sourceId, "longhorn");
    const pvc = pvcs.find((p) => p.metadata.namespace === v.pvc.namespace && p.metadata.name === v.pvc.name);
    assert.equal(v.pvc.uid, pvc?.metadata.uid);
    assert.equal(v.target.id, "longhorn:nfs://nas.example.lan:/volume1/longhorn");
    assert.equal(v.policy.certainty, "certain");
  }
  const byName = new Map(list.map((v) => [v.pvc.name, v]));

  const healthy = byName.get(P.protected.name)!;
  assert.equal(healthy.policy.description, "Longhorn recurring job db-backup (0 2 * * *)");
  assert.equal(healthy.policy.expectedEveryMs, DAY);
  assert.deepEqual(healthy.lastGood, { at: "2026-10-07T02:00:00.000Z", ref: "backup-1b2c3d4e5f607182" });
  assert.deepEqual(healthy.lastAttempt, { at: "2026-10-07T02:00:00.000Z", ok: true });

  assert.equal(byName.get(P.stale.name)!.policy.expectedEveryMs, 7 * DAY);

  const failing = byName.get(P.failing.name)!;
  assert.equal(failing.lastGood?.ref, "backup-77ac9e0c1d2f3a45");
  assert.equal(failing.lastAttempt?.ok, false);
  assert.match(failing.lastAttempt!.message!, /connection refused/);

  const never = byName.get(P.neverRun.name)!;
  assert.equal(never.lastGood, undefined);
  assert.equal(never.lastAttempt, undefined);
});

test("source: a volume restored from a backup is restore evidence for its origin", async () => {
  const k8s = cluster();
  const restored = volume(L.unprotected);
  restored.metadata.name = "pvc-restore-test";
  restored.metadata.creationTimestamp = "2026-10-01T09:00:00.000Z";
  restored.spec = {
    ...restored.spec,
    fromBackup: `nfs://nas.example.lan:/volume1/longhorn?backup=backup-2c3d4e5f60718293&volume=${L.healthy}`,
  };
  restored.status!.kubernetesStatus = {};
  k8s.upsert(RESOURCES.longhornVolumes, restored);
  const list = await setup(k8s).source.list();
  assert.ok(list !== "absent");
  const healthy = list.find((v) => v.pvc.name === P.protected.name)!;
  assert.deepEqual(healthy.restoreEvidence, {
    at: "2026-10-01T09:00:00.000Z",
    ref: "pvc-restore-test",
    kind: "volume-from-backup",
  });
  assert.equal(list.find((v) => v.pvc.name === P.stale.name)?.restoreEvidence, undefined);
});

// --- metrics ----------------------------------------------------------------

test("metrics: provisioned and actual size per volume", async () => {
  const samples = await setup().collector.collect();
  const volumes = fixtureItems(fixtures, RESOURCES.longhornVolumes).length;
  assert.equal(samples.filter((s) => s.series === SIZE_SERIES).length, volumes);
  assert.equal(samples.filter((s) => s.series === ACTUAL_SERIES).length, volumes);
  const size = samples.find((s) => s.series === SIZE_SERIES && s.labels.volume === L.healthy)!;
  assert.deepEqual(size.labels, { volume: L.healthy, namespace: P.protected.namespace, pvc: P.protected.name });
  assert.equal(size.value, 10 * 2 ** 30);
  assert.equal(size.ts, MOCK_NOW);
});

// --- module ----------------------------------------------------------------

test("module: registers both providers, the collector and the backup source", async () => {
  const mock = createMockContext("longhorn", { migrations, services: { k8s: cluster() } });
  try {
    await mod.register(mock.ctx);
    const providers = mock.ctx.health.list();
    assert.deepEqual(
      providers.map((p) => [p.id, p.category]),
      [
        [STORAGE_PROVIDER_ID, "storage"],
        [BACKUPS_PROVIDER_ID, "backups"],
      ]
    );
    assert.deepEqual(
      mock.ctx.metrics.list().map((c) => c.id),
      ["longhorn"]
    );
    const sources = mock.ctx.backups.sources();
    assert.deepEqual(
      sources.map((s) => s.id),
      ["longhorn"]
    );
    const list = await sources[0]!.list();
    assert.ok(list !== "absent" && list.length === 4);
  } finally {
    await mock.close();
  }
});

test("module: without the k8s service every check reads unknown", async () => {
  const mock = createMockContext("longhorn", { migrations });
  try {
    await mod.register(mock.ctx);
    for (const provider of mock.ctx.health.list()) {
      const results = await provider.collect();
      assert.equal(results[0]?.status, "unknown");
    }
  } finally {
    await mock.close();
  }
});

test("target URLs lose a user:password but keep s3's bucket@region", () => {
  assert.equal(redactUrl("s3://backups@us-east-1/longhorn"), "s3://backups@us-east-1/longhorn");
  assert.equal(redactUrl("cifs://user:secret@nas/share"), "cifs://nas/share");
  assert.equal(redactUrl("nfs://nas.example.lan:/volume1/longhorn"), "nfs://nas.example.lan:/volume1/longhorn");
});

// --- nodes, replicas, snapshots ----------------------------------------------

const mockLonghorn = (ref: ResourceRef) => mockLonghornObjects().find((o) => o.ref === ref)!.items;

function replica(volumeName: string, nodeID: string, state: string, failedAt = ""): KubeObject {
  return {
    metadata: {
      name: `${volumeName}-r-${nodeID}`,
      namespace: "longhorn-system",
      labels: { longhornvolume: volumeName },
    },
    spec: { volumeName, nodeID, failedAt },
    status: { currentState: state },
  };
}

test("nodes: disk free space against Longhorn's minimal-available percentage", async () => {
  const k8s = cluster();
  k8s.set(RESOURCES.longhornNodes, mockLonghorn(RESOURCES.longhornNodes));
  const results = byId(await setup(k8s).storage.collect());
  // The synthetic settings set the minimum to 25%.
  assert.equal(results.get("node:node-1")?.status, "ok");
  assert.equal(results.get("node:node-1")?.value, 62);
  const low = results.get("node:node-2")!;
  assert.equal(low.status, "crit");
  assert.match(low.detail, /default-disk 8% free, under half the 25% minimum/);
  const down = results.get("node:node-3")!;
  assert.equal(down.status, "crit");
  assert.match(down.detail, /node not ready/);
  assert.ok(down.raw);

  const tight = structuredClone(mockLonghorn(RESOURCES.longhornNodes)[1]!) as KubeObject & {
    status: { diskStatus: Record<string, { storageAvailable: number }> };
  };
  tight.status.diskStatus["default-disk"]!.storageAvailable = 20 * 2 ** 30;
  k8s.upsert(RESOURCES.longhornNodes, tight);
  const warned = byId(await setup(k8s).storage.collect()).get("node:node-2")!;
  assert.equal(warned.status, "warn");
  assert.match(warned.detail, /20% free, under the 25% minimum: no new replicas/);
});

test("replicas: running count against desired on attached volumes", async () => {
  const k8s = cluster();
  k8s.set(RESOURCES.longhornReplicas, [
    replica(L.healthy, "worker-1", "running"),
    replica(L.healthy, "cp-1", "running"),
    replica(L.degraded, "worker-1", "running"),
    replica(L.degraded, "worker-2", "error", "2026-10-07T10:00:00.000Z"),
    // Detached: stopped replicas are not counted.
    replica(L.detached, "worker-1", "stopped"),
  ]);
  const results = byId(await setup(k8s).storage.collect());
  assert.equal(results.get(`volume:${L.healthy}`)?.status, "ok");
  assert.match(results.get(`volume:${L.healthy}`)!.detail, /2 of 2 replicas running$/);
  const degraded = results.get(`volume:${L.degraded}`)!;
  assert.equal(degraded.status, "warn");
  assert.match(degraded.detail, /1 of 2 replicas running \(worker-2 error since 2026-10-07T10:00:00.000Z\)/);
  assert.equal(results.get(`volume:${L.detached}`)?.status, "ok");

  // Longhorn still calls it healthy, but only one replica runs.
  k8s.set(RESOURCES.longhornReplicas, [
    replica(L.healthy, "worker-1", "running"),
    replica(L.healthy, "cp-1", "stopped"),
  ]);
  assert.equal(byId(await setup(k8s).storage.collect()).get(`volume:${L.healthy}`)?.status, "warn");
  k8s.set(RESOURCES.longhornReplicas, [replica(L.healthy, "worker-1", "error"), replica(L.healthy, "cp-1", "error")]);
  assert.equal(byId(await setup(k8s).storage.collect()).get(`volume:${L.healthy}`)?.status, "crit");
});

const snap = (name: string, volumeName: string, hoursAgo: number, extra: Record<string, unknown> = {}): KubeObject => ({
  metadata: { name, namespace: "longhorn-system", labels: { longhornvolume: volumeName } },
  spec: { volume: volumeName },
  status: {
    creationTime: new Date(MOCK_NOW - hoursAgo * HOUR).toISOString(),
    readyToUse: true,
    labels: { RecurringJob: "hourly-snap" },
    ...extra,
  },
});

test("snapshots: errors are reported and snapshot jobs judged against their cron", async () => {
  const k8s = cluster();
  // hourly-snap covers no volumes in the fixtures; give it the healthy one.
  const v = volume(L.healthy);
  v.metadata.labels = { ...v.metadata.labels, "recurring-job.longhorn.io/hourly-snap": "enabled" };
  k8s.upsert(RESOURCES.longhornVolumes, v);

  k8s.set(RESOURCES.longhornSnapshots, [snap("snap-a", L.healthy, 2.5), snap("snap-b", L.healthy, 6)]);
  let storage = byId(await setup(k8s).storage.collect());
  let backups = byId(await setup(k8s).backups.collect());
  assert.equal(storage.get("snapshots")?.status, "ok");
  assert.equal(storage.get("snapshots")?.detail, "2 snapshots, none failed");
  // Due at 10:00 with 2h grace; the newest is from 09:30, so 10:00 was missed.
  assert.equal(backups.get("job:hourly-snap")?.status, "warn");
  assert.equal(backups.get("job:hourly-snap")?.value, 1);

  k8s.set(RESOURCES.longhornSnapshots, [
    snap("snap-a", L.healthy, 2.5),
    snap("snap-c", L.healthy, 1.5, { error: "failed to create snapshot: context deadline exceeded" }),
    snap("snap-old", L.healthy, 50, { error: "gone", markRemoved: true }),
  ]);
  storage = byId(await setup(k8s).storage.collect());
  backups = byId(await setup(k8s).backups.collect());
  const errors = storage.get("snapshots")!;
  assert.equal(errors.status, "warn");
  assert.equal(errors.value, 1);
  assert.match(errors.detail, /snap-c of databases\/data-postgres-0: failed to create snapshot/);
  assert.equal(backups.get("job:hourly-snap")?.status, "ok");

  k8s.set(RESOURCES.longhornSnapshots, mockLonghorn(RESOURCES.longhornSnapshots));
  assert.equal(byId(await setup(k8s).storage.collect()).get("snapshots")?.status, "ok");
});

test("an older chart without the new reads hides only those checks", async () => {
  const k8s = cluster();
  const denied = new Set<ResourceRef>([
    RESOURCES.longhornNodes,
    RESOURCES.longhornReplicas,
    RESOURCES.longhornSnapshots,
  ]);
  const partial: K8sApi = {
    ...k8s,
    list: async (ref, opts) => {
      if (denied.has(ref)) throw new Error(`forbidden: cannot list ${ref.plural}.longhorn.io`);
      return k8s.list(ref, opts);
    },
  };
  const results = byId(await setup(partial).storage.collect());
  for (const id of ["nodes", "replicas", "snapshots"]) {
    assert.equal(results.get(id)?.status, "unknown", id);
    assert.match(results.get(id)!.detail, /forbidden/);
  }
  assert.equal(results.get(`volume:${L.healthy}`)?.status, "ok");
  const backups = byId(await setup(partial).backups.collect());
  assert.equal(backups.get("job:hourly-snap")?.status, "ok");
});

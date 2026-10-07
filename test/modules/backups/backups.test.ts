import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { BackupPosture, ProtectedVolume, RestoreTestMark } from "../../../src/contracts/backups.js";
import { RESOURCES } from "../../../src/contracts/k8s.js";
import {
  DAY,
  HOUR,
  MOCK_NOW,
  createFakeK8s,
  createMockBackupSource,
  createMockCapacitySource,
  createMockContext,
  isoAgo,
  mockAdmin,
  mockClusterObjects,
  mockFailingVolume,
  mockNeverBackedUpVolume,
  mockProtectedVolume,
  mockProtectedVolumes,
  mockPvcs,
  mockStaleVolume,
  mockTargets,
  mockViewer,
  type MockContext,
} from "../../../src/contracts/mocks/index.js";
import backups, { createPostureService, healthResults, objectOf, selfPod } from "../../../src/modules/backups/index.js";
import { listPvcs, parseQuantity, type ClusterPvc } from "../../../src/modules/backups/cluster.js";
import { csvCell, postureCsv } from "../../../src/modules/backups/csv.js";
import { migrations } from "../../../src/modules/backups/migrations.js";
import { buildPosture, judge, type PostureInput, type SourceOutcome } from "../../../src/modules/backups/posture.js";
import { DEFAULT_OPTIONS, declareSettings } from "../../../src/modules/backups/settings.js";
import { createStore } from "../../../src/modules/backups/store.js";
import { fixtureItems, loadFixtureSet, scenarios } from "../../support/index.js";
import { listen } from "../../runtime/helpers.js";
import longhorn from "../../../src/modules/longhorn/index.js";
import velero from "../../../src/modules/velero/index.js";
import { targetOnPath } from "../../../src/modules/hosts/service.js";

const clusterPvcs: ClusterPvc[] = Object.values(mockPvcs).map((ref) => ({
  ref,
  sizeBytes: 10 * 2 ** 30,
  storageClass: "longhorn",
}));

const ok = (id: string, volumes: ProtectedVolume[]): SourceOutcome => ({
  id,
  label: id,
  result: { state: "ok", volumes },
});

function input(overrides: Partial<PostureInput> = {}): PostureInput {
  return {
    pvcs: clusterPvcs,
    sources: [
      ok(
        "longhorn",
        mockProtectedVolumes.filter((v) => v.sourceId === "longhorn")
      ),
      ok(
        "velero",
        mockProtectedVolumes.filter((v) => v.sourceId === "velero")
      ),
    ],
    capacity: new Map(),
    marks: new Map(),
    now: MOCK_NOW,
    options: DEFAULT_OPTIONS,
    ...overrides,
  };
}

const ownData = (ref: (typeof mockPvcs)[keyof typeof mockPvcs]) =>
  clusterPvcs.map((p) => (p.ref.uid === ref.uid ? { ...p, ownData: true } : p));

const rowOf = (posture: BackupPosture, pvc: { name: string }) => {
  const row = posture.rows.find((r) => r.pvc.name === pvc.name);
  assert.ok(row, `no row for ${pvc.name}`);
  return row;
};

describe("judge", () => {
  test("a fresh backup inside its policy is ok", () => {
    assert.deepEqual(judge(mockProtectedVolume, MOCK_NOW, DEFAULT_OPTIONS), {
      status: "ok",
      detail: "10 hours old against a daily policy",
      ageMs: 10 * HOUR,
    });
  });

  test("past the warn factor is warn, past the crit factor is crit", () => {
    assert.equal(judge(mockStaleVolume, MOCK_NOW, DEFAULT_OPTIONS).status, "warn");
    assert.equal(judge(mockStaleVolume, MOCK_NOW, DEFAULT_OPTIONS).detail, "3 days old against a daily policy");
    const old = { ...mockStaleVolume, lastGood: { at: isoAgo(5 * DAY), ref: "x" } };
    assert.equal(judge(old, MOCK_NOW, DEFAULT_OPTIONS).status, "crit");
    assert.equal(judge(old, MOCK_NOW, { ...DEFAULT_OPTIONS, critFactor: 10 }).status, "warn");
  });

  test("a failed attempt newer than the last good backup is crit", () => {
    const result = judge(mockFailingVolume, MOCK_NOW, DEFAULT_OPTIONS);
    assert.equal(result.status, "crit");
    assert.equal(result.detail, "Last attempt failed: backup target unreachable: connection refused");
  });

  test("a failed attempt followed by a good backup is judged on the good one", () => {
    const recovered: ProtectedVolume = {
      ...mockFailingVolume,
      lastAttempt: { at: isoAgo(12 * HOUR), ok: false, message: "timeout" },
      lastGood: { at: isoAgo(2 * HOUR), ref: "b" },
    };
    assert.equal(judge(recovered, MOCK_NOW, DEFAULT_OPTIONS).status, "ok");
  });

  test("covered but never backed up is warn; no interval is ok", () => {
    assert.deepEqual(judge(mockNeverBackedUpVolume, MOCK_NOW, DEFAULT_OPTIONS), {
      status: "warn",
      detail: "Covered, never backed up yet",
    });
    const noInterval = { ...mockProtectedVolume, policy: { description: "manual" } };
    assert.equal(judge(noInterval, MOCK_NOW, DEFAULT_OPTIONS).detail, "10 hours old (the policy sets no interval)");
  });

  test("other intervals are spelled out", () => {
    const sixHourly = { ...mockProtectedVolume, policy: { description: "x", expectedEveryMs: 6 * HOUR } };
    assert.equal(judge(sixHourly, MOCK_NOW, DEFAULT_OPTIONS).detail, "10 hours old against a policy of every 6 hours");
  });
});

describe("buildPosture", () => {
  test("matches the contract mock: unprotected first, then worst first", () => {
    const posture = buildPosture(input());
    assert.deepEqual(
      posture.rows.map((r) => [r.pvc.name, r.status, r.protected]),
      [
        ["scratch-cache", "crit", false],
        ["grafana", "crit", true],
        ["gitea-shared-storage", "warn", true],
        ["jellyfin-config", "warn", true],
        ["postgres-data", "ok", true],
      ]
    );
    const scratch = rowOf(posture, mockPvcs.scratch);
    assert.equal(scratch.ageDetail, "Not covered by any backup");
    assert.deepEqual(scratch.coverage, []);
    assert.equal(scratch.target, undefined);

    const postgres = rowOf(posture, mockPvcs.postgres);
    assert.deepEqual(postgres.lastGood, { ...mockProtectedVolume.lastGood, sourceId: "longhorn" });
    assert.deepEqual(postgres.restoreTested, {
      at: mockProtectedVolume.restoreEvidence!.at,
      from: "evidence",
      ref: mockProtectedVolume.restoreEvidence!.ref,
    });
    assert.deepEqual(postgres.target, mockTargets.nas);
    assert.equal(postgres.pvc.sizeBytes, 10 * 2 ** 30);

    assert.deepEqual(posture.sources, [
      { id: "longhorn", label: "longhorn", state: "ok", volumes: 3 },
      { id: "velero", label: "velero", state: "ok", volumes: 1 },
    ]);
    assert.equal(posture.generatedAt, new Date(MOCK_NOW).toISOString());
  });

  test("with no backup system installed every PVC is unprotected and critical", () => {
    const posture = buildPosture(input({ sources: [{ id: "velero", label: "Velero", result: { state: "absent" } }] }));
    assert.ok(posture.rows.every((r) => !r.protected && r.status === "crit"));
    assert.deepEqual(posture.sources, [{ id: "velero", label: "Velero", state: "absent", volumes: 0 }]);
  });

  test("a failed source makes uncovered PVCs unknown rather than unprotected", () => {
    const posture = buildPosture(
      input({
        sources: [
          ok("longhorn", [mockProtectedVolume]),
          { id: "velero", label: "Velero", result: { state: "error", error: "forbidden" } },
        ],
      })
    );
    const gitea = rowOf(posture, mockPvcs.gitea);
    assert.equal(gitea.status, "unknown");
    assert.match(gitea.ageDetail, /velero could not be read/);
    assert.deepEqual(posture.sources[1], {
      id: "velero",
      label: "Velero",
      state: "error",
      volumes: 0,
      error: "forbidden",
    });
  });

  test("ignored PVCs read as absent when unprotected, and are still judged when covered", () => {
    const posture = buildPosture(input({ options: { ...DEFAULT_OPTIONS, ignore: ["apps"] } }));
    const scratch = rowOf(posture, mockPvcs.scratch);
    assert.equal(scratch.status, "absent");
    assert.match(scratch.ageDetail, /ignored in settings/);
    assert.equal(rowOf(posture, mockPvcs.postgres).status, "ok");

    const byName = buildPosture(input({ options: { ...DEFAULT_OPTIONS, ignore: ["apps/scratch-cache"] } }));
    assert.equal(rowOf(byName, mockPvcs.scratch).status, "absent");
  });

  test("the console's own volume is informational when uncovered, and judged when covered", () => {
    const posture = buildPosture(input({ pvcs: ownData(mockPvcs.scratch) }));
    const scratch = rowOf(posture, mockPvcs.scratch);
    assert.equal(scratch.status, "absent");
    assert.match(scratch.ageDetail, /own data/);
    assert.equal(rowOf(buildPosture(input({ pvcs: ownData(mockPvcs.postgres) })), mockPvcs.postgres).status, "ok");
  });

  test("an uncovered NFS volume warns instead of being critical", () => {
    const pvcs = clusterPvcs.map((p) => (p.ref.uid === mockPvcs.scratch.uid ? { ...p, nfs: true } : p));
    const scratch = rowOf(buildPosture(input({ pvcs })), mockPvcs.scratch);
    assert.equal(scratch.status, "warn");
    assert.match(scratch.ageDetail, /backups may exist on the storage server/);
    const ignored = buildPosture(input({ pvcs, options: { ...DEFAULT_OPTIONS, ignore: ["apps"] } }));
    assert.equal(rowOf(ignored, mockPvcs.scratch).status, "absent");
  });

  test("two sources: the best copy decides, the newest good backup is reported", () => {
    const veleroCopy: ProtectedVolume = {
      ...mockStaleVolume,
      pvc: mockPvcs.grafana,
      lastGood: { at: isoAgo(5 * HOUR), ref: "velero-1" },
      lastAttempt: { at: isoAgo(5 * HOUR), ok: true },
    };
    const posture = buildPosture(input({ sources: [ok("longhorn", [mockFailingVolume]), ok("velero", [veleroCopy])] }));
    const grafana = rowOf(posture, mockPvcs.grafana);
    assert.equal(grafana.coverage.length, 2);
    assert.equal(grafana.status, "ok");
    assert.deepEqual(grafana.lastGood, { at: veleroCopy.lastGood!.at, ref: "velero-1", sourceId: "velero" });
    assert.deepEqual(grafana.target, mockTargets.s3);
  });

  test("matches by uid, falling back to namespace and name when a source has none", () => {
    const noUid = { ...mockProtectedVolume, pvc: { ...mockPvcs.postgres, uid: "" } };
    const otherUid = { ...mockStaleVolume, pvc: { ...mockPvcs.gitea, uid: "recreated" } };
    const posture = buildPosture(input({ sources: [ok("longhorn", [noUid]), ok("velero", [otherUid])] }));
    assert.equal(rowOf(posture, mockPvcs.postgres).protected, true);
    assert.equal(rowOf(posture, mockPvcs.gitea).protected, false);
  });

  test("target space is attached, and a nearly full target warns", () => {
    const roomy = buildPosture(input({ capacity: new Map([[mockTargets.nas.id, { free: 1.2e12, total: 4e12 }]]) }));
    assert.deepEqual(rowOf(roomy, mockPvcs.postgres).target, { ...mockTargets.nas, free: 1.2e12, total: 4e12 });
    assert.equal(rowOf(roomy, mockPvcs.postgres).status, "ok");

    const full = buildPosture(input({ capacity: new Map([[mockTargets.nas.id, { free: 1e11, total: 4e12 }]]) }));
    const postgres = rowOf(full, mockPvcs.postgres);
    assert.equal(postgres.ageStatus, "ok");
    assert.equal(postgres.status, "warn");

    const off = buildPosture(
      input({
        capacity: new Map([[mockTargets.nas.id, { free: 1e11, total: 4e12 }]]),
        options: { ...DEFAULT_OPTIONS, targetFreeWarnPercent: 0 },
      })
    );
    assert.equal(rowOf(off, mockPvcs.postgres).status, "ok");
  });

  test("restore tested is the newer of source evidence and a manual mark", () => {
    const older: RestoreTestMark = { at: isoAgo(40 * DAY), note: "drill", by: "admin" };
    const newer: RestoreTestMark = { at: isoAgo(2 * DAY), note: "restored to scratch", by: "admin" };
    const withOlder = buildPosture(input({ marks: new Map([[mockPvcs.postgres.uid, older]]) }));
    assert.equal(rowOf(withOlder, mockPvcs.postgres).restoreTested?.from, "evidence");
    const withNewer = buildPosture(input({ marks: new Map([[mockPvcs.postgres.uid, newer]]) }));
    assert.deepEqual(rowOf(withNewer, mockPvcs.postgres).restoreTested, {
      at: newer.at,
      from: "manual",
      note: "restored to scratch",
    });
    const unprotected = buildPosture(input({ marks: new Map([[mockPvcs.scratch.uid, newer]]) }));
    assert.equal(rowOf(unprotected, mockPvcs.scratch).restoreTested?.from, "manual");
  });
});

const ownedPod = (name: string, claim: string, owner: [string, string], labels?: Record<string, string>) => ({
  metadata: {
    name,
    namespace: "apps",
    ...(labels ? { labels } : {}),
    ownerReferences: [{ apiVersion: "v1", kind: owner[0], name: owner[1], uid: name, controller: true }],
  },
  spec: { volumes: [{ name: "data", persistentVolumeClaim: { claimName: claim } }] },
});
const ownedBy = (name: string, parent: [string, string]) => ({
  metadata: {
    name,
    namespace: "apps",
    ownerReferences: [{ apiVersion: "v1", kind: parent[0], name: parent[1], uid: name, controller: true }],
  },
});

describe("cluster", () => {
  test("parses quantities", () => {
    assert.equal(parseQuantity("10Gi"), 10 * 2 ** 30);
    assert.equal(parseQuantity("500M"), 5e8);
    assert.equal(parseQuantity("1.5Ti"), 1.5 * 2 ** 40);
    assert.equal(parseQuantity("1e9"), 1e9);
    assert.equal(parseQuantity("1024"), 1024);
    assert.equal(parseQuantity("lots"), undefined);
    assert.equal(parseQuantity(undefined), undefined);
  });

  test("lists PVCs from the synthetic fixtures with the workloads that mount them", async () => {
    const set = loadFixtureSet("synthetic");
    const pvcs = await listPvcs(createFakeK8s({ objects: set.lists }));
    const find = (ref: { namespace: string; name: string }) =>
      pvcs.find((p) => p.ref.namespace === ref.namespace && p.ref.name === ref.name);
    const c = scenarios.pvcs;

    assert.equal(pvcs.length, fixtureItems(set, RESOURCES.pvcs).length);
    assert.equal(find(c.protected)?.app, "StatefulSet/postgres");
    assert.equal(find(c.stale)?.app, "StatefulSet/jellyfin");
    // The fixtures have no ReplicaSet for this pod and no hash label to read it from.
    assert.equal(find(c.failing)?.app, "ReplicaSet/uploads-api-5c6d8f7b9");
    assert.equal(find(c.protected)?.sizeBytes, 10 * 2 ** 30);
    assert.equal(find(c.protected)?.storageClass, "longhorn");
    assert.ok(find(c.protected)?.ref.uid);
    // Pending: no capacity yet, so the request is the size.
    assert.equal(find(c.pending)?.sizeBytes, 50 * 2 ** 30);
    assert.equal(find(c.unprotected)?.app, undefined);
  });

  test("follows ReplicaSet to Deployment and Job to CronJob, or reads the hash label", async () => {
    const k8s = createFakeK8s({
      objects: [
        {
          ref: RESOURCES.pvcs,
          items: ["web", "dump", "orphan", "shared"].map((name) => ({
            metadata: { name, namespace: "apps", uid: name },
          })),
        },
        {
          ref: RESOURCES.pods,
          items: [
            ownedPod("web-abc12-x", "web", ["ReplicaSet", "web-abc12"]),
            ownedPod("dump-1-x", "dump", ["Job", "dump-1"]),
            ownedPod("orphan-def34-x", "orphan", ["ReplicaSet", "orphan-def34"], { "pod-template-hash": "def34" }),
            ownedPod("a", "shared", ["StatefulSet", "b"]),
            {
              metadata: { name: "bare", namespace: "apps" },
              spec: { volumes: [{ persistentVolumeClaim: { claimName: "shared" } }] },
            },
          ],
        },
        { ref: RESOURCES.replicaSets, items: [ownedBy("web-abc12", ["Deployment", "web"])] },
        { ref: RESOURCES.jobs, items: [ownedBy("dump-1", ["CronJob", "dump"])] },
      ],
    });
    const apps = Object.fromEntries((await listPvcs(k8s)).map((p) => [p.ref.name, p.app]));
    assert.deepEqual(apps, {
      web: "Deployment/web",
      dump: "CronJob/dump",
      orphan: "Deployment/orphan",
      shared: "Pod/bare, StatefulSet/b",
    });
  });

  test("marks the volume this console's own pod mounts", async () => {
    const k8s = createFakeK8s({
      objects: [
        {
          ref: RESOURCES.pvcs,
          items: ["data", "other"].map((name) => ({ metadata: { name, namespace: "console", uid: name } })),
        },
        {
          ref: RESOURCES.pods,
          items: [
            {
              metadata: { name: "console-abc", namespace: "console" },
              spec: { volumes: [{ persistentVolumeClaim: { claimName: "data" } }] },
            },
            {
              metadata: { name: "console-abc", namespace: "elsewhere" },
              spec: { volumes: [{ persistentVolumeClaim: { claimName: "other" } }] },
            },
          ],
        },
      ],
    });
    const own = async (self?: { name: string; namespace?: string }) =>
      (await listPvcs(k8s, self)).filter((p) => p.ownData).map((p) => p.ref.name);
    assert.deepEqual(await own({ name: "console-abc", namespace: "console" }), ["data"]);
    assert.deepEqual(await own(undefined), []);
  });

  test("selfPod only answers for the production image", () => {
    assert.equal(selfPod({ NODE_ENV: "development", HOSTNAME: "x" }), undefined);
  });

  test("recognises NFS by storage class provisioner or name, and by an NFS PV", async () => {
    const k8s = createFakeK8s({
      objects: [
        {
          ref: RESOURCES.pvcs,
          items: [
            { metadata: { name: "csi", namespace: "a", uid: "1" }, spec: { storageClassName: "nas" } },
            { metadata: { name: "named", namespace: "a", uid: "2" }, spec: { storageClassName: "my-nfs" } },
            {
              metadata: { name: "static", namespace: "a", uid: "3" },
              spec: { storageClassName: "", volumeName: "pv-nfs" },
            },
            { metadata: { name: "block", namespace: "a", uid: "4" }, spec: { storageClassName: "longhorn" } },
          ],
        },
        {
          ref: RESOURCES.storageClasses,
          items: [
            { metadata: { name: "nas" }, provisioner: "nfs.csi.k8s.io" },
            { metadata: { name: "my-nfs" }, provisioner: "example.com/custom" },
            { metadata: { name: "longhorn" }, provisioner: "driver.longhorn.io" },
          ],
        },
        { ref: RESOURCES.pvs, items: [{ metadata: { name: "pv-nfs" }, spec: { nfs: { server: "nas", path: "/x" } } }] },
      ],
    });
    const nfs = (await listPvcs(k8s)).filter((p) => p.nfs).map((p) => p.ref.name);
    assert.deepEqual(nfs.toSorted(), ["csi", "named", "static"]);
  });

  test("the real capture's nfs-nas volumes are recognised as NFS", async () => {
    const set = loadFixtureSet("real");
    const pvcs = await listPvcs(createFakeK8s({ objects: set.lists }));
    const onNas = pvcs.filter((p) => p.storageClass === "nfs-nas");
    assert.ok(onNas.length > 0);
    assert.ok(onNas.every((p) => p.nfs));
    assert.ok(pvcs.filter((p) => p.storageClass?.startsWith("longhorn")).every((p) => !p.nfs));
  });

  test("a StatefulSet scaled to zero still owns its claims", async () => {
    const k8s = createFakeK8s({
      objects: [
        {
          ref: RESOURCES.pvcs,
          items: [
            { metadata: { name: "data-redis-0", namespace: "cache", uid: "u1" } },
            { metadata: { name: "data-redis-extra", namespace: "cache", uid: "u2" } },
          ],
        },
        {
          ref: RESOURCES.statefulSets,
          items: [
            {
              metadata: { name: "redis", namespace: "cache" },
              spec: { replicas: 0, volumeClaimTemplates: [{ metadata: { name: "data" } }] },
            },
          ],
        },
      ],
    });
    const pvcs = await listPvcs(k8s);
    assert.equal(pvcs.find((p) => p.ref.name === "data-redis-0")?.app, "StatefulSet/redis");
    assert.equal(pvcs.find((p) => p.ref.name === "data-redis-extra")?.app, undefined);
  });
});

describe("csv", () => {
  test("quotes and defuses formulas", () => {
    assert.equal(csvCell(undefined), "");
    assert.equal(csvCell(42), "42");
    assert.equal(csvCell(true), "true");
    assert.equal(csvCell("plain"), "plain");
    assert.equal(csvCell('a,"b"'), '"a,""b"""');
    assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
    assert.equal(csvCell("-1+1"), "'-1+1");
    assert.equal(csvCell("line\nbreak"), '"line\nbreak"');
  });

  test("one header and one line per row", () => {
    const csv = postureCsv(buildPosture(input()));
    const lines = csv.trimEnd().split("\r\n");
    assert.equal(lines.length, 6);
    assert.match(
      lines[0]!,
      /^namespace,pvc,uid,app,size_bytes,storage_class,status,protected,sources,policy,last_good/
    );
    assert.match(
      lines[1]!,
      /^apps,scratch-cache,11111111-0000-4000-8000-000000000005,,10737418240,longhorn,crit,false,/
    );
    assert.match(lines[2]!, /"Longhorn recurring job daily-backup \(0 2 \* \* \*\)"|Longhorn recurring job/);
  });
});

describe("health results", () => {
  test("one check per PVC, raw on failures, plus failed sources", () => {
    const posture = buildPosture(
      input({
        sources: [
          ok(
            "longhorn",
            mockProtectedVolumes.filter((v) => v.sourceId === "longhorn")
          ),
          { id: "velero", label: "Velero", result: { state: "error", error: "timeout" } },
        ],
      })
    );
    const results = healthResults(posture);
    assert.deepEqual(
      results.map((r) => [r.id, r.status]),
      [
        ["source/velero", "unknown"],
        ["pvc/apps/scratch-cache", "unknown"],
        ["pvc/gitea/gitea-shared-storage", "unknown"],
        ["pvc/monitoring/grafana", "crit"],
        ["pvc/media/jellyfin-config", "warn"],
        ["pvc/apps/postgres-data", "ok"],
      ]
    );
    const postgres = results.find((r) => r.id === "pvc/apps/postgres-data")!;
    assert.equal(postgres.raw, undefined);
    assert.equal(postgres.value, 10);
    assert.equal(postgres.label, "apps/postgres-data");
    assert.ok(results.find((r) => r.id === "pvc/monitoring/grafana")!.raw);
    assert.ok(results.every((r) => r.detail.length > 0));
  });

  test("each PVC check links to the app that mounts it, or to the claim", () => {
    const row = (app?: string) => ({
      ...rowOf(buildPosture(input()), mockPvcs.postgres),
      ...(app === undefined ? { app: undefined } : { app }),
    });
    assert.deepEqual(objectOf(row("Deployment/beszel, StatefulSet/b")), {
      kind: "Deployment",
      namespace: mockPvcs.postgres.namespace,
      name: "beszel",
    });
    assert.deepEqual(objectOf(row()), {
      kind: "PersistentVolumeClaim",
      namespace: mockPvcs.postgres.namespace,
      name: mockPvcs.postgres.name,
    });
    const results = healthResults(buildPosture(input()));
    assert.ok(results.filter((r) => r.id.startsWith("pvc/")).every((r) => r.object));
  });

  test("low target space is named in the detail", () => {
    const posture = buildPosture(input({ capacity: new Map([[mockTargets.nas.id, { free: 1e11, total: 4e12 }]]) }));
    const postgres = healthResults(posture).find((r) => r.id === "pvc/apps/postgres-data")!;
    assert.equal(postgres.status, "warn");
    assert.equal(postgres.detail, "10 hours old against a daily policy; target 3% free");
  });

  test("an empty cluster is one ok result", () => {
    assert.deepEqual(
      healthResults(buildPosture(input({ pvcs: [] }))).map((r) => [r.id, r.status]),
      [["pvcs", "ok"]]
    );
  });
});

describe("posture service", () => {
  test("gathers sources and capacity through the registries", async () => {
    const m = createMockContext("backups", {
      migrations,
      services: { k8s: createFakeK8s({ objects: mockClusterObjects() }) },
    });
    try {
      let lists = 0;
      const counted = createMockBackupSource("longhorn");
      m.ctx.backups.addSource({ ...counted, list: () => (lists++, counted.list()) });
      m.ctx.backups.addSource({
        id: "broken",
        label: "Broken",
        list: async () => {
          throw new Error("boom");
        },
      });
      m.ctx.backups.addCapacity({
        id: "throws",
        targetMatch: () => {
          throw new Error("bad matcher");
        },
        freeBytes: async () => ({ free: 0, total: 0 }),
      });
      m.ctx.backups.addCapacity(createMockCapacitySource(mockTargets.nas, 2e12, 4e12));

      let now = MOCK_NOW;
      const service = createPostureService(
        m.ctx,
        createStore(m.ctx.db, m.ctx.orgId),
        declareSettings(m.ctx.settings),
        () => now
      );
      const posture = await service.get();
      assert.deepEqual(
        posture.sources.map((s) => [s.id, s.state]),
        [
          ["longhorn", "ok"],
          ["broken", "error"],
        ]
      );
      assert.deepEqual(rowOf(posture, mockPvcs.postgres).target, { ...mockTargets.nas, free: 2e12, total: 4e12 });
      assert.equal(rowOf(posture, mockPvcs.postgres).pvc.sizeBytes, 10 * 2 ** 30);

      await service.get();
      assert.equal(lists, 1, "a second call inside the cache window reuses the first");
      now += 60_000;
      await service.get();
      assert.equal(lists, 2);
      await Promise.all([service.get(0), service.get(0)]);
      assert.equal(lists, 3, "concurrent calls share one gathering");
    } finally {
      await m.close();
    }
  });
});

describe("HTTP and health provider", () => {
  let m: MockContext;
  let server: { url: string; close(): Promise<void> };

  before(async () => {
    m = createMockContext("backups", {
      migrations,
      services: { k8s: createFakeK8s({ objects: mockClusterObjects() }) },
    });
    m.ctx.backups.addSource(createMockBackupSource("longhorn"));
    m.ctx.backups.addSource(createMockBackupSource("velero"));
    await backups.register(m.ctx);
    server = await listen(m.app);
  });

  after(async () => {
    await server.close();
    await m.close();
  });

  const call = (path: string, init?: RequestInit) =>
    fetch(`${server.url}/api/backups${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });

  test("GET /posture lists every PVC, unprotected first", async () => {
    const res = await call("/posture");
    assert.equal(res.status, 200);
    const posture = (await res.json()) as BackupPosture;
    assert.equal(posture.rows.length, 5);
    assert.equal(posture.rows[0]!.pvc.name, "scratch-cache");
    assert.equal(posture.rows[0]!.protected, false);
    assert.ok(posture.rows.slice(1).every((r) => r.protected));
  });

  test("GET /posture.csv downloads the same table", async () => {
    const res = await call("/posture.csv");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/csv/);
    assert.match(
      res.headers.get("content-disposition") ?? "",
      /attachment; filename="backup-posture-\d{4}-\d{2}-\d{2}\.csv"/
    );
    const lines = (await res.text()).trimEnd().split("\r\n");
    assert.equal(lines.length, 6);
    assert.ok(lines[0]!.startsWith("namespace,pvc,"));
  });

  test("POST restore-tests: write access, validation, unknown PVC", async () => {
    const path = `/volumes/${mockPvcs.gitea.uid}/restore-tests`;
    m.setUser(mockViewer);
    const forbidden = await call(path, { method: "POST", body: JSON.stringify({ at: "2026-10-01", note: "x" }) });
    assert.equal(forbidden.status, 403);
    m.setUser(mockAdmin);

    const bad = await call(path, { method: "POST", body: JSON.stringify({ at: "yesterday" }) });
    assert.equal(bad.status, 400);
    const future = await call(path, { method: "POST", body: JSON.stringify({ at: "2999-01-01" }) });
    assert.equal(future.status, 400);
    const missing = await call("/volumes/nope/restore-tests", {
      method: "POST",
      body: JSON.stringify({ at: "2026-10-01" }),
    });
    assert.equal(missing.status, 404);
    assert.equal(m.audit.length, 0);
  });

  test("POST restore-tests records, audits and shows on the posture", async () => {
    const res = await call(`/volumes/${mockPvcs.gitea.uid}/restore-tests`, {
      method: "POST",
      body: JSON.stringify({ at: "2026-10-05T09:30:00Z", note: "  Restored into scratch namespace  " }),
    });
    assert.equal(res.status, 200);
    const mark = (await res.json()) as RestoreTestMark;
    assert.deepEqual(mark, { at: "2026-10-05T09:30:00.000Z", note: "Restored into scratch namespace", by: "admin" });
    assert.deepEqual(m.audit.at(-1), {
      actor: "admin",
      action: "backups.mark-restore-tested",
      target: "gitea/gitea-shared-storage",
      detail: "2026-10-05T09:30:00.000Z: Restored into scratch namespace",
    });

    const posture = (await (await call("/posture")).json()) as BackupPosture;
    assert.deepEqual(rowOf(posture, mockPvcs.gitea).restoreTested, {
      at: "2026-10-05T09:30:00.000Z",
      from: "manual",
      note: "Restored into scratch namespace",
    });
  });

  test("the provider reports one check per PVC under the backups category", async () => {
    const provider = m.ctx.health.list().find((p) => p.id === "backups");
    assert.ok(provider);
    assert.equal(provider.category, "backups");
    const results = await provider.collect();
    assert.equal(results.length, 5);
    assert.deepEqual(results[0], {
      ...results[0],
      id: "pvc/apps/scratch-cache",
      status: "crit",
      detail: "Not covered by any backup",
    });
  });
});

describe("without the Kubernetes API", () => {
  test("the page answers 503 and the provider reports unknown", async () => {
    const m = createMockContext("backups", { migrations });
    try {
      await backups.register(m.ctx);
      const server = await listen(m.app);
      try {
        const res = await fetch(`${server.url}/api/backups/posture`);
        assert.equal(res.status, 503);
        assert.deepEqual(await res.json(), { error: "The Kubernetes API is not available." });
      } finally {
        await server.close();
      }
      const results = await m.ctx.health.list()[0]!.collect();
      assert.deepEqual(
        results.map((r) => [r.id, r.status, r.detail]),
        [["pvcs", "unknown", "The Kubernetes API is not available."]]
      );
    } finally {
      await m.close();
    }
  });

  test("a failing list answers 502 with the reason", async () => {
    const k8s = createFakeK8s();
    k8s.list = async () => {
      throw new Error("forbidden: persistentvolumeclaims");
    };
    const m = createMockContext("backups", { migrations, services: { k8s } });
    try {
      await backups.register(m.ctx);
      const server = await listen(m.app);
      try {
        const res = await fetch(`${server.url}/api/backups/posture`);
        assert.equal(res.status, 502);
        assert.match(((await res.json()) as { error: string }).error, /^Could not list PVCs: forbidden/);
      } finally {
        await server.close();
      }
    } finally {
      await m.close();
    }
  });
});

describe("against the Longhorn and Velero sources", () => {
  test("synthetic fixtures through the real sources and a host's capacity matcher", async () => {
    const k8s = createFakeK8s({ objects: loadFixtureSet("synthetic").lists });
    const lh = createMockContext("longhorn", { migrations: longhorn.migrations, services: { k8s } });
    const ve = createMockContext("velero", { migrations: velero.migrations, services: { k8s } });
    const m = createMockContext("backups", { migrations, services: { k8s } });
    try {
      await longhorn.register(lh.ctx);
      await velero.register(ve.ctx);
      for (const source of [...lh.ctx.backups.sources(), ...ve.ctx.backups.sources()]) m.ctx.backups.addSource(source);
      const nas = { address: "nas.example.lan", facts: "{}" } as unknown as Parameters<typeof targetOnPath>[0];
      m.ctx.backups.addCapacity({
        id: "hosts:nas:/volume1",
        targetMatch: (target) => targetOnPath(nas, "/volume1", target),
        freeBytes: async () => ({ free: 3e12, total: 8e12 }),
      });

      const service = createPostureService(
        m.ctx,
        createStore(m.ctx.db, m.ctx.orgId),
        declareSettings(m.ctx.settings),
        () => MOCK_NOW
      );
      const posture = await service.get();
      assert.deepEqual(
        posture.sources.map((s) => [s.id, s.state]),
        [
          ["longhorn", "ok"],
          ["velero", "ok"],
        ]
      );

      const c = scenarios.pvcs;
      const row = (ref: { namespace: string; name: string }) => {
        const found = posture.rows.find((r) => r.pvc.namespace === ref.namespace && r.pvc.name === ref.name);
        assert.ok(found, `${ref.namespace}/${ref.name}`);
        return found;
      };
      const summary = (ref: { namespace: string; name: string }) => {
        const r = row(ref);
        return [r.status, r.coverage.map((v) => v.sourceId).toSorted()];
      };
      assert.deepEqual(summary(c.protected), ["ok", ["longhorn", "velero"]]);
      assert.deepEqual(summary(c.failing), ["crit", ["longhorn"]]);
      assert.deepEqual(summary(c.neverRun), ["warn", ["longhorn"]]);
      assert.deepEqual(summary(c.unprotected), ["crit", []]);
      assert.deepEqual(summary(c.pending), ["crit", []]);
      // Longhorn's weekly job is inside its policy; Velero's partial run has no
      // good backup, and the better copy decides.
      assert.deepEqual(summary(c.stale), ["ok", ["longhorn", "velero"]]);

      assert.match(row(c.failing).ageDetail, /^Last attempt failed: .*connection refused/);
      assert.equal(row(c.protected).restoreTested?.from, "evidence");
      assert.deepEqual(
        { free: row(c.protected).target?.free, total: row(c.protected).target?.total },
        { free: 3e12, total: 8e12 }
      );
      assert.equal(posture.rows[0]!.protected, false);
    } finally {
      await lh.close();
      await ve.close();
      await m.close();
    }
  });
});

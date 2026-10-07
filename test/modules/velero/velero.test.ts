import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ProtectedVolume } from "../../../src/contracts/backups.js";
import type { CheckResult } from "../../../src/contracts/health.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { createMockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s, type FakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { DAY, HOUR, MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import velero from "../../../src/modules/velero/index.js";
import { coverageOf, veleroBackupSource } from "../../../src/modules/velero/coverage.js";
import { expectedEveryMs, firesBetween, parseSchedule, previousFire } from "../../../src/modules/velero/cron.js";
import { veleroHealthProvider, type VeleroRules } from "../../../src/modules/velero/health.js";
import type { PodObject, PvcObject } from "../../../src/modules/velero/state.js";
import { loadFixtureSet, scenarios } from "../../support/index.js";

const fixtures = loadFixtureSet("synthetic");
const RULES: VeleroRules = { graceMs: HOUR, restoreMaxAgeMs: 90 * DAY };
const now = () => MOCK_NOW;
const ago = (ms: number) => new Date(MOCK_NOW - ms).toISOString();

function syntheticK8s(): FakeK8s {
  return createFakeK8s({ objects: fixtures.lists.map((l) => ({ ref: l.ref, items: structuredClone(l.items) })) });
}

async function collect(k8s: FakeK8s, rules = RULES): Promise<Map<string, CheckResult>> {
  const results = await veleroHealthProvider(
    () => k8s,
    () => rules,
    now
  ).collect();
  return new Map(results.map((r) => [r.id, r]));
}

async function volumes(k8s: FakeK8s): Promise<ProtectedVolume[]> {
  const list = await veleroBackupSource(() => k8s, now).list();
  assert.notEqual(list, "absent");
  return list as ProtectedVolume[];
}

const schedule = (name: string, cron: string, template: Record<string, unknown>, status: Record<string, unknown>) =>
  ({
    apiVersion: "velero.io/v1",
    kind: "Schedule",
    metadata: { name, namespace: "velero", creationTimestamp: ago(30 * DAY) },
    spec: { schedule: cron, template },
    status: { phase: "Enabled", ...status },
  }) as KubeObject;

const backup = (name: string, scheduleName: string, phase: string, startedAgo: number, spec: Record<string, unknown>) =>
  ({
    apiVersion: "velero.io/v1",
    kind: "Backup",
    metadata: { name, namespace: "velero", labels: { "velero.io/schedule-name": scheduleName } },
    spec,
    status: { phase, startTimestamp: ago(startedAgo), completionTimestamp: ago(startedAgo - 60_000) },
  }) as KubeObject;

describe("cron", () => {
  test("finds the last fire of a daily schedule", () => {
    assert.equal(previousFire(parseSchedule("0 2 * * *"), MOCK_NOW), Date.parse("2026-10-07T02:00:00Z"));
    assert.equal(previousFire(parseSchedule("@daily"), MOCK_NOW), Date.parse("2026-10-07T00:00:00Z"));
    assert.equal(previousFire(parseSchedule("*/15 * * * *"), MOCK_NOW + 7 * 60_000), MOCK_NOW);
    assert.equal(previousFire(parseSchedule("0 0 1 1 *"), MOCK_NOW), Date.parse("2026-01-01T00:00:00Z"));
  });

  test("ORs day-of-month and day-of-week when both are restricted", () => {
    // 2026-10-07 is a Wednesday.
    assert.equal(previousFire(parseSchedule("0 3 1 * WED"), MOCK_NOW), Date.parse("2026-10-07T03:00:00Z"));
    assert.equal(previousFire(parseSchedule("0 3 1 * *"), MOCK_NOW), Date.parse("2026-10-01T03:00:00Z"));
    assert.equal(previousFire(parseSchedule("0 3 * * sun"), MOCK_NOW), Date.parse("2026-10-04T03:00:00Z"));
  });

  test("honours a CRON_TZ prefix", () => {
    // 02:00 in New York during daylight time is 06:00 UTC.
    assert.equal(
      previousFire(parseSchedule("CRON_TZ=America/New_York 0 2 * * *"), MOCK_NOW),
      Date.parse("2026-10-07T06:00:00Z")
    );
  });

  test("expects the longest recent gap between runs", () => {
    assert.equal(expectedEveryMs(parseSchedule("0 2 * * *"), MOCK_NOW), DAY);
    assert.equal(expectedEveryMs(parseSchedule("0 2 * * 1-5"), MOCK_NOW), 3 * DAY);
    assert.equal(expectedEveryMs(parseSchedule("@every 6h"), MOCK_NOW), 6 * HOUR);
    assert.equal(expectedEveryMs(parseSchedule("@every 1h30m"), MOCK_NOW), 90 * 60_000);
  });

  test("counts fires between a last run and now", () => {
    const daily = parseSchedule("0 2 * * *");
    assert.equal(firesBetween(daily, Date.parse("2026-10-07T02:00:05Z"), MOCK_NOW).length, 0);
    assert.equal(firesBetween(daily, Date.parse("2026-10-05T02:00:05Z"), MOCK_NOW).length, 2);
    assert.equal(firesBetween(parseSchedule("@every 6h"), MOCK_NOW - 13 * HOUR, MOCK_NOW).length, 2);
  });

  test("rejects what Velero would reject", () => {
    for (const bad of ["61 * * * *", "0 2 * *", "0 2 * * 8", "@every soon", "0 2 31-1 * *"]) {
      assert.throws(() => parseSchedule(bad), bad);
    }
  });
});

describe("health on the synthetic fixtures", () => {
  test("judges locations, schedules, backups, restores and coverage", async () => {
    const checks = await collect(syntheticK8s());
    const v = scenarios.velero;
    const status = (id: string) => checks.get(id)?.status;

    assert.equal(status(`location:velero/${v.locationAvailable}`), "ok");
    // Unavailable, but neither the default nor used by a schedule.
    const offsite = checks.get(`location:velero/${v.locationUnavailable}`);
    assert.equal(offsite?.status, "warn");
    assert.match(offsite?.detail ?? "", /i\/o timeout/);
    assert.ok(offsite?.raw);

    assert.equal(status(`schedule:velero/${v.schedule}`), "ok");
    const media = checks.get("schedule:velero/daily-media");
    assert.equal(media?.status, "warn");
    assert.equal(media?.value, 1);
    assert.match(media?.detail ?? "", /Missed 1 run/);

    const completed = checks.get(`backup:velero/${v.schedule}`);
    assert.equal(completed?.status, "ok");
    assert.equal(completed?.value, 10);
    assert.match(completed?.detail ?? "", new RegExp(`${v.completed} Completed`));

    const partial = checks.get("backup:velero/daily-media");
    assert.equal(partial?.status, "warn");
    assert.match(partial?.detail ?? "", /PartiallyFailed .*3 errors.*no completed backup on record/);

    // The failed backup's schedule no longer exists.
    const other = checks.get("other-backups");
    assert.equal(other?.status, "warn");
    assert.match(other?.detail ?? "", new RegExp(`${v.failed} Failed \\(.*connection refused\\)`));

    const restore = checks.get("restore");
    assert.equal(restore?.status, "ok");
    assert.equal(restore?.value, 7);

    const coverage = checks.get("coverage");
    assert.equal(coverage?.status, "ok");
    assert.equal(coverage?.value, 1);
    assert.match(coverage?.detail ?? "", /2 of 3 namespaces; not covered: default/);

    for (const result of checks.values()) {
      assert.ok(result.detail, `${result.id} has a detail`);
      if (result.status !== "ok") assert.ok(result.raw !== undefined, `${result.id} carries raw`);
    }
  });

  test("reports absent Velero as one hidden check", async () => {
    const results = await veleroHealthProvider(
      () => createFakeK8s({ absentGroups: ["velero.io"] }),
      () => RULES,
      now
    ).collect();
    assert.deepEqual(
      results.map((r) => [r.id, r.status]),
      [["installed", "absent"]]
    );
  });

  test("is unknown, not thrown, when the cluster can't be read", async () => {
    const results = await veleroHealthProvider(
      () => {
        throw new Error('service "k8s" has not been provided');
      },
      () => RULES,
      now
    ).collect();
    assert.equal(results.length, 1);
    assert.equal(results[0]?.status, "unknown");
    assert.match(results[0]?.detail ?? "", /k8s/);
  });
});

describe("health rules", () => {
  test("a schedule two runs behind is critical, and so is its location when unavailable", async () => {
    const k8s = syntheticK8s();
    k8s.upsert(
      RESOURCES.veleroSchedules,
      schedule("nightly", "0 2 * * *", { storageLocation: "offsite" }, { lastBackup: ago(58 * HOUR) })
    );
    const checks = await collect(k8s);
    assert.equal(checks.get("schedule:velero/nightly")?.status, "crit");
    assert.equal(checks.get("schedule:velero/nightly")?.value, 2);
    assert.equal(checks.get("location:velero/offsite")?.status, "crit");
  });

  test("an old completed backup is critical even when the latest run is fine to read", async () => {
    const k8s = syntheticK8s();
    k8s.upsert(RESOURCES.veleroSchedules, schedule("weekly", "0 3 * * 0", {}, { lastBackup: ago(3 * DAY + 9 * HOUR) }));
    k8s.upsert(RESOURCES.veleroBackups, backup("weekly-20260913030000", "weekly", "Completed", 24 * DAY, {}));
    k8s.upsert(RESOURCES.veleroBackups, backup("weekly-20261004030000", "weekly", "Failed", 3 * DAY, {}));
    const checks = await collect(k8s);
    const result = checks.get("backup:velero/weekly");
    assert.equal(result?.status, "crit");
    assert.match(result?.detail ?? "", /last completed weekly-20260913030000 24d ago/);
    assert.equal(result?.value, 24 * 24);
  });

  test("paused and invalid schedules, failed and missing restores", async () => {
    const k8s = syntheticK8s();
    const paused = schedule("paused", "0 1 * * *", {}, {});
    (paused.spec as { paused?: boolean }).paused = true;
    k8s.upsert(RESOURCES.veleroSchedules, paused);
    k8s.upsert(
      RESOURCES.veleroSchedules,
      schedule("broken", "0 1 * * *", {}, { phase: "FailedValidation", validationErrors: ["invalid schedule"] })
    );
    k8s.upsert(RESOURCES.veleroRestores, {
      apiVersion: "velero.io/v1",
      kind: "Restore",
      metadata: { name: "restore-media", namespace: "velero" },
      spec: { backupName: scenarios.velero.partial },
      status: { phase: "Failed", startTimestamp: ago(HOUR), completionTimestamp: ago(HOUR), failureReason: "boom" },
    });
    let checks = await collect(k8s);
    assert.equal(checks.get("schedule:velero/paused")?.status, "warn");
    assert.equal(checks.get("schedule:velero/broken")?.status, "crit");
    assert.match(checks.get("schedule:velero/broken")?.detail ?? "", /invalid schedule/);
    assert.equal(checks.get("restore")?.status, "crit");
    assert.match(checks.get("restore")?.detail ?? "", /boom.*last completed restore-databases-20260930 7d ago/);

    k8s.set(RESOURCES.veleroRestores, []);
    checks = await collect(k8s);
    assert.equal(checks.get("restore")?.status, "warn");

    checks = await collect(syntheticK8s(), { ...RULES, restoreMaxAgeMs: 5 * DAY });
    assert.equal(checks.get("restore")?.status, "warn");
    assert.match(checks.get("restore")?.detail ?? "", /older than 5 days/);
  });

  test("an installed Velero with no schedules or locations says so", async () => {
    const k8s = createFakeK8s({ objects: [{ ref: RESOURCES.veleroBackups, items: [] }] });
    const checks = await collect(k8s);
    assert.equal(checks.get("schedules")?.status, "warn");
    assert.equal(checks.get("locations")?.status, "warn");
    assert.equal(checks.has("installed"), false);
  });
});

describe("backup source", () => {
  test("lists each covered PVC per schedule with its last backup, attempt, target and restore", async () => {
    const list = await volumes(syntheticK8s());
    const byName = new Map(list.map((v) => [`${v.pvc.namespace}/${v.pvc.name}`, v]));
    assert.deepEqual([...byName.keys()].toSorted(), ["databases/data-postgres-0", "media/media-library"]);

    const db = byName.get("databases/data-postgres-0")!;
    assert.equal(db.sourceId, "velero");
    assert.ok(db.pvc.uid);
    assert.equal(db.policy.certainty, "certain");
    assert.equal(db.policy.expectedEveryMs, DAY);
    assert.match(db.policy.description, /daily-databases \(0 2 \* \* \*\), file system backup/);
    assert.deepEqual(db.lastGood, { at: ago(10 * HOUR), ref: scenarios.velero.completed });
    assert.deepEqual(db.lastAttempt, { at: ago(10 * HOUR), ok: true });
    assert.deepEqual(db.target, {
      id: "velero:default",
      label: "Velero default (s3://velero/cluster)",
      url: "s3://velero/cluster",
    });
    // Restored from a backup that has since expired; its name ties it to the schedule.
    assert.deepEqual(db.restoreEvidence, {
      at: ago(7 * DAY - 5 * 60_000),
      ref: scenarios.velero.restore,
      kind: "restore-object",
    });

    const media = byName.get("media/media-library")!;
    assert.equal(media.lastGood, undefined);
    assert.deepEqual(media.lastAttempt, { at: ago(34 * HOUR), ok: false, message: "3 errors" });
    assert.equal(media.restoreEvidence, undefined);
  });

  test("is absent when Velero isn't installed", async () => {
    const list = await veleroBackupSource(() => createFakeK8s({ absentGroups: ["velero.io"] }), now).list();
    assert.equal(list, "absent");
  });

  test("leaves out paused schedules", async () => {
    const k8s = syntheticK8s();
    const paused = schedule("all", "0 4 * * *", {}, {});
    (paused.spec as { paused?: boolean }).paused = true;
    k8s.upsert(RESOURCES.veleroSchedules, paused);
    const list = await volumes(k8s);
    assert.equal(list.filter((v) => v.policy.description.includes("schedule all ")).length, 0);
  });

  test("an all-namespace schedule without fs-backup is only probable", async () => {
    const k8s = syntheticK8s();
    k8s.upsert(RESOURCES.veleroSchedules, schedule("everything", "0 4 * * *", {}, {}));
    const list = await volumes(k8s);
    const mine = list.filter((v) => v.policy.description.includes("schedule everything "));
    assert.equal(mine.length, 6);
    assert.ok(mine.every((v) => v.policy.certainty === "probable"));
    assert.ok(mine.every((v) => /volume snapshot/.test(v.policy.description)));
  });
});

const pvc = (labels?: Record<string, string>): PvcObject => ({
  metadata: { name: "data", namespace: "apps", uid: "u1", ...(labels ? { labels } : {}) },
});
const pod = (annotations: Record<string, string> = {}, labels: Record<string, string> = {}): PodObject => ({
  metadata: { name: "app-0", namespace: "apps", annotations, labels },
  spec: { volumes: [{ name: "vol", persistentVolumeClaim: { claimName: "data" } }] },
  status: { phase: "Running" },
});

describe("coverage resolution", () => {
  test("namespace and resource filters", () => {
    assert.equal(coverageOf(pvc(), [], { includedNamespaces: ["other"] }), undefined);
    assert.equal(coverageOf(pvc(), [], { excludedNamespaces: ["ap*"] }), undefined);
    assert.equal(coverageOf(pvc(), [], { excludedResources: ["persistentvolumeclaims"] }), undefined);
    assert.equal(coverageOf(pvc(), [], { includedResources: ["deployments"] }), undefined);
    assert.ok(coverageOf(pvc(), [], { includedResources: ["pvc"] }));
  });

  test("fs-backup by default or by pod opt-in is certain; an opt-out falls back to snapshots", () => {
    assert.deepEqual(coverageOf(pvc(), [pod()], { defaultVolumesToFsBackup: true }), {
      method: "fs-backup",
      certainty: "certain",
      doubts: [],
    });
    assert.equal(
      coverageOf(pvc(), [pod({ "backup.velero.io/backup-volumes": "other, vol" })], {})?.certainty,
      "certain"
    );
    const optedOut = coverageOf(pvc(), [pod({ "backup.velero.io/backup-volumes-excludes": "vol" })], {
      defaultVolumesToFsBackup: true,
    });
    assert.equal(optedOut?.method, "snapshot");
    assert.equal(optedOut?.certainty, "probable");
    assert.equal(coverageOf(pvc(), [pod()], { snapshotVolumes: false }), undefined);
  });

  test("label selectors match the claim or a pod that mounts it", () => {
    const spec = { labelSelector: { matchLabels: { backup: "yes" } }, defaultVolumesToFsBackup: true };
    assert.equal(coverageOf(pvc(), [pod()], spec), undefined);
    assert.equal(coverageOf(pvc({ backup: "yes" }), [pod()], spec)?.certainty, "probable");
    assert.equal(coverageOf(pvc(), [pod({}, { backup: "yes" })], spec)?.certainty, "probable");
    const expr = { labelSelector: { matchExpressions: [{ key: "tier", operator: "NotIn", values: ["cache"] }] } };
    assert.ok(coverageOf(pvc({ tier: "db" }), [], expr));
    assert.equal(coverageOf(pvc({ tier: "cache" }), [], expr), undefined);
  });

  test("a volume policy makes coverage probable", () => {
    const result = coverageOf(pvc(), [pod()], {
      defaultVolumesToFsBackup: true,
      resourcePolicy: { kind: "configmap", name: "skip-small" },
    });
    assert.equal(result?.certainty, "probable");
    assert.match(result?.doubts.join() ?? "", /skip-small/);
  });
});

describe("module", () => {
  test("registers a backups-category provider and a backup source", async () => {
    const mock = createMockContext("velero", {
      migrations: velero.migrations ?? [],
      services: { k8s: createFakeK8s({ absentGroups: ["velero.io"] }) },
    });
    try {
      await velero.register(mock.ctx);
      const provider = mock.ctx.health.list().find((p) => p.id === "velero");
      assert.equal(provider?.category, "backups");
      const results = await provider!.collect();
      assert.deepEqual(
        results.map((r) => r.status),
        ["absent"]
      );
      const source = mock.ctx.backups.sources().find((s) => s.id === "velero");
      assert.equal(await source?.list(), "absent");
    } finally {
      await mock.close();
    }
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { createMockStorageTargets } from "../../../src/contracts/mocks/connectors/storage.js";
import { createMockContext, mockViewer } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import { pgClusterLabel, pgClusterName } from "../../../src/contracts/postgres.js";
import { ageStatus, backupView, cronIntervalMs, readBackupObjects } from "../../../src/modules/postgres/backups.js";
import { register } from "../../../src/modules/postgres/index.js";
import { migrations } from "../../../src/modules/postgres/migrations.js";
import { readSnapshot } from "../../../src/modules/postgres/read.js";
import { product } from "../../../src/product.js";

const NS = "postgres";
const NAME = pgClusterName(product.slug);
const STORE = `${NAME}-store`;
const now = new Date(MOCK_NOW);
const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(MOCK_NOW - msAgo).toISOString();
const managed = { "app.kubernetes.io/managed-by": product.ownerMarker.labelDomain };

function cluster(archiving: boolean | "failing"): KubeObject {
  return {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: { name: NAME, namespace: NS, labels: { [pgClusterLabel(product.ownerMarker.labelDomain)]: "current" } },
    spec: {
      instances: 2,
      ...(archiving
        ? {
            plugins: [
              {
                name: "barman-cloud.cloudnative-pg.io",
                isWALArchiver: true,
                parameters: { barmanObjectName: STORE, serverName: NAME },
              },
            ],
          }
        : {}),
    },
    status: {
      phase: "Cluster in healthy state",
      readyInstances: 2,
      conditions: archiving
        ? [
            archiving === "failing"
              ? { type: "ContinuousArchiving", status: "False", message: "access denied" }
              : { type: "ContinuousArchiving", status: "True" },
          ]
        : [],
    },
  } as KubeObject;
}

const store = {
  apiVersion: "barmancloud.cnpg.io/v1",
  kind: "ObjectStore",
  metadata: { name: STORE, namespace: NS },
  spec: { retentionPolicy: "14d", configuration: { destinationPath: "s3://cluster-backups/postgres/" } },
  status: {
    serverRecoveryWindow: {
      [NAME]: { firstRecoverabilityPoint: iso(14 * 24 * HOUR), lastSuccessfulBackupTime: iso(10 * HOUR) },
    },
  },
} as KubeObject;

const schedule = {
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "ScheduledBackup",
  metadata: { name: `${NAME}-backups`, namespace: NS },
  spec: { schedule: "0 0 2 * * *", cluster: { name: NAME } },
} as KubeObject;

const backup = (name: string, phase: string, msAgo: number, error?: string) =>
  ({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Backup",
    metadata: { name, namespace: NS },
    spec: { cluster: { name: NAME } },
    status: { phase, stoppedAt: iso(msAgo), ...(error ? { error } : {}) },
  }) as KubeObject;

const cron = {
  apiVersion: "batch/v1",
  kind: "CronJob",
  metadata: { name: `${NAME}-dump`, namespace: NS, labels: managed },
  spec: {
    schedule: "0 2 * * *",
    successfulJobsHistoryLimit: 14,
    jobTemplate: {
      spec: {
        template: { spec: { volumes: [{ name: "dumps", persistentVolumeClaim: { claimName: `${NAME}-dumps` } }] } },
      },
    },
  },
} as KubeObject;

const dumpJob = (name: string, msAgo: number, ok: boolean) =>
  ({
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace: NS },
    status: ok
      ? { succeeded: 1, startTime: iso(msAgo + 60_000), completionTime: iso(msAgo) }
      : { startTime: iso(msAgo), conditions: [{ type: "Failed", status: "True", message: "BackoffLimitExceeded" }] },
  }) as KubeObject;

function fake(o: {
  cluster?: KubeObject;
  stores?: KubeObject[];
  backups?: KubeObject[];
  crons?: KubeObject[];
  jobs?: KubeObject[];
  longhornUrl?: string;
}) {
  return createFakeK8s({
    objects: [
      { ref: RESOURCES.cnpgClusters, items: o.cluster ? [o.cluster] : [] },
      { ref: RESOURCES.cnpgDatabases, items: [] },
      { ref: RESOURCES.cnpgDatabaseRoles, items: [] },
      { ref: RESOURCES.barmanObjectStores, items: o.stores ?? [] },
      { ref: RESOURCES.cnpgScheduledBackups, items: o.stores ? [schedule] : [] },
      { ref: RESOURCES.cnpgBackups, items: o.backups ?? [] },
      { ref: RESOURCES.cronJobs, items: o.crons ?? [] },
      { ref: RESOURCES.jobs, items: o.jobs ?? [] },
      { ref: RESOURCES.pods, items: [] },
      {
        ref: RESOURCES.pvcs,
        items: [
          {
            apiVersion: "v1",
            kind: "PersistentVolumeClaim",
            metadata: { name: `${NAME}-1`, namespace: NS, uid: "pvc-1", labels: { "cnpg.io/cluster": NAME } },
          } as KubeObject,
        ],
      },
      {
        ref: RESOURCES.longhornBackupTargets,
        items: o.longhornUrl
          ? [
              {
                apiVersion: "longhorn.io/v1beta2",
                kind: "BackupTarget",
                metadata: { name: "default", namespace: "longhorn-system" },
                spec: { backupTargetURL: o.longhornUrl },
              } as KubeObject,
            ]
          : [],
      },
    ],
  });
}

async function view(k8s: ReturnType<typeof fake>) {
  const state = await backupView(
    await readSnapshot(k8s),
    await readBackupObjects(k8s),
    createMockStorageTargets(),
    now
  );
  return state.view;
}

test("cron intervals and ages", () => {
  assert.equal(cronIntervalMs("0 2 * * *"), 24 * HOUR);
  assert.equal(cronIntervalMs("0 0 */6 * * *"), 6 * HOUR);
  assert.equal(cronIntervalMs("0 * * * *"), HOUR);
  assert.equal(cronIntervalMs("0 3 * * 0"), 7 * 24 * HOUR);
  assert.equal(ageStatus(iso(10 * HOUR), 24 * HOUR, now), "ok");
  assert.equal(ageStatus(iso(40 * HOUR), 24 * HOUR, now), "warn");
  assert.equal(ageStatus(iso(80 * HOUR), 24 * HOUR, now), "crit");
  assert.equal(ageStatus(undefined, 24 * HOUR, now), "warn");
});

test("point-in-time: target, window, archiving and base backups, newest first", async () => {
  const v = await view(
    fake({
      cluster: cluster(true),
      stores: [store],
      backups: [backup("b-old", "failed", 58 * HOUR, "InvalidAccessKeyId"), backup("b-new", "completed", 10 * HOUR)],
    })
  );
  assert.equal(v.method, "pitr");
  assert.equal(v.connectorId, "cn_st2");
  assert.equal(v.targetName, "MinIO");
  assert.equal(v.destination, "s3://cluster-backups/postgres/");
  assert.equal(v.schedule, "0 2 * * *");
  assert.equal(v.retention, 14);
  assert.equal(v.status, "ok");
  assert.equal(v.firstRecoverabilityPoint, iso(14 * 24 * HOUR));
  assert.deepEqual(v.archiving, { ok: true });
  assert.deepEqual(
    v.restorePoints.map((p) => [p.id, p.state]),
    [
      ["b-new", "completed"],
      ["b-old", "failed"],
    ]
  );
  assert.match(v.detail, /WAL archiving on; last base backup 10 hours ago/);
});

test("point-in-time: failing archiving is critical with the operator's message", async () => {
  const v = await view(fake({ cluster: cluster("failing"), stores: [store] }));
  assert.equal(v.status, "crit");
  assert.deepEqual(v.archiving, { ok: false, message: "access denied" });
});

test("dumps: target through Longhorn, restore points from the CronJob's Jobs", async () => {
  const v = await view(
    fake({
      cluster: cluster(false),
      crons: [cron],
      jobs: [
        dumpJob(`${NAME}-dump-2`, 10 * HOUR, true),
        dumpJob(`${NAME}-dump-1`, 34 * HOUR, true),
        dumpJob("other", HOUR, true),
      ],
      longhornUrl: "nfs://nas.example.test:/volume1/backups/cluster/",
    })
  );
  assert.equal(v.method, "dump");
  assert.equal(v.targetName, "NAS backups");
  assert.equal(v.destination, `postgres/${NAME}-dumps`);
  assert.equal(v.status, "ok");
  assert.deepEqual(
    v.restorePoints.map((p) => p.id),
    [`${NAME}-dump-2`, `${NAME}-dump-1`]
  );
  assert.deepEqual(v.lastDump, { at: iso(10 * HOUR), ok: true });

  const failed = await view(
    fake({
      cluster: cluster(false),
      crons: [cron],
      jobs: [dumpJob(`${NAME}-dump-3`, HOUR, false), dumpJob(`${NAME}-dump-2`, 10 * HOUR, true)],
    })
  );
  assert.equal(failed.status, "warn");
  assert.match(failed.detail, /BackoffLimitExceeded/);
});

test("none: a warning while the cluster has no backups; absent without a cluster", async () => {
  const off = await view(fake({ cluster: cluster(false) }));
  assert.deepEqual([off.method, off.status], ["none", "warn"]);
  const none = await view(fake({}));
  assert.deepEqual([none.method, none.status], ["none", "absent"]);
});

test("module: the cluster's volumes join the backup posture; changes go through deploy actions", async () => {
  const mock = createMockContext("postgres", {
    migrations,
    services: {
      k8s: fake({ cluster: cluster(true), stores: [store], backups: [backup("b-new", "completed", 10 * HOUR)] }),
      "storage-targets": createMockStorageTargets(),
    },
  });
  const server: Server = await new Promise((resolve) => {
    const s = mock.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    register(mock.ctx, { now: () => now });
    const [source] = mock.ctx.backups.sources();
    const volumes = await source!.list();
    assert.ok(volumes !== "absent");
    assert.deepEqual(
      volumes.map((v) => [v.pvc.name, v.lastGood?.at, v.policy.expectedEveryMs]),
      [[`${NAME}-1`, iso(10 * HOUR), 24 * HOUR]]
    );

    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/postgres`;
    const send = (method: string, path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    assert.equal(((await (await send("GET", "/backups")).json()) as { method: string }).method, "pitr");
    assert.equal((await send("PUT", "/backups", { connectorId: "cn_nope" })).status, 404);
    assert.equal((await send("PUT", "/backups", { connectorId: "cn_st2", schedule: "bad" })).status, 400);
    assert.equal((await send("PUT", "/backups", { connectorId: "cn_st2", retention: 30 })).status, 200);
    assert.equal((await send("POST", "/backups/now")).status, 200);
    assert.equal((await send("POST", "/restore/plan", {})).status, 400);
    assert.equal((await send("POST", "/restore", { at: "2026-10-06T10:42:00Z" })).status, 200);
    assert.deepEqual(
      mock.calls.map((c) => [c.key, (c.input as { body?: unknown }).body]),
      [
        ["POST /api/deploy/actions/run", { kind: "pg-backups", connectorId: "cn_st2", retention: 30 }],
        ["POST /api/deploy/actions/run", { kind: "pg-backup-now" }],
        ["POST /api/deploy/actions/run", { kind: "pg-restore", at: "2026-10-06T10:42:00Z" }],
      ]
    );

    mock.setUser(mockViewer);
    assert.equal((await send("POST", "/backups/now")).status, 403);
  } finally {
    server.close();
    await mock.close();
  }
});

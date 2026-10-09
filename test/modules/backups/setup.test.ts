import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { BackupPosture, BackupSchedulesView, BackupTargetView } from "../../../src/contracts/backups.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { createMockStorageTargets } from "../../../src/contracts/mocks/connectors/storage.js";
import { createMockContext, mockViewer, type MockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s, type FakeK8s } from "../../../src/contracts/mocks/k8s.js";
import backups from "../../../src/modules/backups/index.js";
import { migrations } from "../../../src/modules/backups/migrations.js";
import { product } from "../../../src/product.js";
import { listen } from "../../runtime/helpers.js";

const LH = "longhorn-system";
const prefix = product.ownerMarker.externalPrefix;

let env: { mock: MockContext; server: { url: string; close(): Promise<void> } } | undefined;

afterEach(async () => {
  await env?.server.close();
  await env?.mock.close();
  env = undefined;
});

function cluster(target: { url: string; available?: boolean; message?: string }): FakeK8s {
  const owned = createFakeK8s().ownedLabels();
  return createFakeK8s({
    objects: [
      {
        ref: RESOURCES.pvcs,
        items: [
          {
            metadata: { name: "pg-data", namespace: "apps", uid: "uid-pg" },
            spec: { storageClassName: "longhorn", resources: { requests: { storage: "10Gi" } }, volumeName: "pvc-pg" },
            status: { phase: "Bound" },
          },
        ],
      },
      {
        ref: RESOURCES.longhornBackupTargets,
        items: [
          {
            metadata: { name: "default", namespace: LH },
            spec: { backupTargetURL: target.url },
            status: {
              ...(target.available === undefined ? {} : { available: target.available }),
              ...(target.message
                ? { conditions: [{ type: "Unavailable", status: "True", message: target.message }] }
                : {}),
            },
          },
        ],
      },
      {
        ref: RESOURCES.longhornRecurringJobs,
        items: [
          {
            metadata: { name: `${prefix}default-snapshot`, namespace: LH, labels: owned },
            spec: { task: "snapshot", cron: "0 * * * *", retain: 24, groups: ["default"] },
          },
          {
            metadata: { name: `${prefix}default-backup`, namespace: LH, labels: owned },
            spec: { task: "backup", cron: "0 3 * * *", retain: 14, groups: ["default"] },
          },
          { metadata: { name: "theirs", namespace: LH }, spec: { task: "backup", cron: "0 1 * * *", groups: ["x"] } },
        ],
      },
      {
        ref: RESOURCES.longhornVolumes,
        items: [
          {
            metadata: { name: "pvc-pg", namespace: LH },
            status: { kubernetesStatus: { namespace: "apps", pvcName: "pg-data" } },
          },
        ],
      },
      {
        ref: RESOURCES.longhornBackups,
        items: [
          {
            metadata: { name: "backup-1", namespace: LH, labels: { "backup-volume": "pvc-pg" } },
            status: {
              state: "Completed",
              volumeName: "pvc-pg",
              size: "1024",
              snapshotCreatedAt: "2026-10-08T03:00:00Z",
              labels: { RecurringJob: `${prefix}default-backup` },
            },
          },
          {
            metadata: { name: "backup-2", namespace: LH, labels: { "backup-volume": "pvc-pg" } },
            status: { state: "InProgress", volumeName: "pvc-pg", snapshotCreatedAt: "2026-10-08T09:00:00Z" },
          },
        ],
      },
    ] as Array<{ ref: (typeof RESOURCES)[keyof typeof RESOURCES]; items: KubeObject[] }>,
  });
}

async function start(target: { url: string; available?: boolean; message?: string }) {
  const mock = createMockContext("backups", {
    migrations,
    services: { k8s: cluster(target), "storage-targets": createMockStorageTargets() },
  });
  backups.register(mock.ctx);
  env = { mock, server: await listen(mock.app) };
  return env;
}

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}, status = 200): Promise<T> {
  const res = await fetch(`${env!.server.url}/api/backups${path}`, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  assert.equal(res.status, status, await res.clone().text());
  return (await res.json()) as T;
}

test("the target names the connector its URL came from, with Longhorn's own word on it", async () => {
  await start({ url: "nfs://nas.example.test:/volume1/backups/cluster", available: true });
  const view = await api<BackupTargetView>("/target");
  assert.equal(view.connectorId, "cn_st1");
  assert.equal(view.protocol, "nfs");
  assert.equal(view.available, true);
});

test("schedules come back per group from this product's RecurringJobs only", async () => {
  await start({ url: "" });
  const view = await api<BackupSchedulesView>("/schedules");
  assert.deepEqual(view.schedules, [
    { group: "default", snapshotCron: "0 * * * *", snapshotRetain: 24, backupCron: "0 3 * * *", backupRetain: 14 },
  ]);
  assert.equal(view.suggested, undefined);
});

test("set-up changes run as deploy actions as the caller, after checking the request", async () => {
  const { mock } = await start({ url: "" });
  await api("/target", { method: "PUT", body: { connectorId: "cn_st2" } });
  assert.deepEqual(mock.calls.at(-1)!.input, { body: { kind: "longhorn-target", connectorId: "cn_st2" } });
  await api("/target", { method: "PUT", body: { connectorId: "cn_nope" } }, 404);

  await api("/schedules", { method: "PUT", body: { schedules: [{ group: "x y", backupCron: "0 3 * * *" }] } }, 400);
  await api(
    "/schedules",
    { method: "PUT", body: { schedules: [{ group: "a", backupCron: "0 3 * * *" }, { group: "a" }] } },
    400
  );
  await api("/schedules", { method: "PUT", body: { schedules: [{ group: "critical", backupCron: "0 */6 * * *" }] } });
  assert.equal(mock.calls.at(-1)!.key, "POST /api/deploy/actions/run");

  await api("/volumes/uid-pg/groups", { method: "PUT", body: { groups: ["critical", "critical"] } });
  assert.deepEqual(mock.calls.at(-1)!.input, {
    body: { kind: "longhorn-recurring", volumes: [{ namespace: "apps", claim: "pg-data", groups: ["critical"] }] },
  });
  await api("/volumes/uid-pg/backup-now", { method: "POST" });
  assert.deepEqual(mock.calls.at(-1)!.input, {
    body: { kind: "longhorn-backup-now", namespace: "apps", claim: "pg-data" },
  });
  await api("/volumes/uid-nope/backup-now", { method: "POST" }, 404);

  await api("/restore", { method: "POST", body: { uid: "uid-pg", backupId: "backup-1", mode: "new-pvc" } });
  const restore = mock.calls.at(-1)!.input as { body: { newClaim: string } };
  assert.match(restore.body.newClaim, /^pg-data-restored-\d{8}$/);

  mock.setUser(mockViewer);
  await api("/schedules", { method: "PUT", body: { schedules: [] } }, 403);
});

test("restore points are the volume's backups, newest first", async () => {
  await start({ url: "" });
  const points =
    await api<Array<{ id: string; state: string; createdBy?: string; sizeBytes?: number }>>("/volumes/uid-pg/backups");
  assert.deepEqual(
    points.map((p) => [p.id, p.state, p.createdBy, p.sizeBytes]),
    [
      ["backup-2", "in-progress", "manual", undefined],
      ["backup-1", "completed", `${prefix}default-backup`, 1024],
    ]
  );
});

test("an unreachable target makes Longhorn-covered volumes critical on the posture", async () => {
  const { mock } = await start({ url: "nfs://nas:/b", available: false, message: "mount.nfs: access denied" });
  mock.ctx.backups.addSource({
    id: "longhorn",
    label: "Longhorn",
    list: async () => [
      {
        pvc: { namespace: "apps", name: "pg-data", uid: "uid-pg" },
        sourceId: "longhorn",
        policy: { description: "daily", expectedEveryMs: 86_400_000 },
        lastGood: { at: new Date().toISOString(), ref: "backup-1" },
        target: { id: "longhorn:nfs", label: "nfs://nas:/b" },
      },
    ],
  });
  const posture = await api<BackupPosture>("/posture");
  const row = posture.rows.find((r) => r.pvc.name === "pg-data")!;
  assert.equal(row.status, "crit");
  assert.match(row.ageDetail, /can't reach its backup target: mount.nfs: access denied/);
  assert.deepEqual(row.groups, ["default"]);
  assert.equal(row.lastBackupAt, "2026-10-08T03:00:00.000Z");
  assert.equal(posture.target?.available, false);
  assert.equal(posture.schedules?.length, 1);
});

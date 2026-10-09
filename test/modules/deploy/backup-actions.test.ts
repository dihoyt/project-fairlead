import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeployActionRequest } from "../../../src/contracts/deploy.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import {
  createMockStorageTargets,
  MOCK_STORAGE_SECRET_VALUE,
} from "../../../src/contracts/mocks/connectors/storage.js";
import { createFakeK8s, type FakeK8s } from "../../../src/contracts/mocks/k8s.js";
import {
  actionRecipe,
  actionSchema,
  type ActionContext,
  type ActionRendered,
} from "../../../src/modules/deploy/actions/index.js";
import { product } from "../../../src/product.js";

const LH = "longhorn-system";
const prefix = product.ownerMarker.externalPrefix;
const owned = createFakeK8s().ownedLabels();

interface ClusterOptions {
  targetUrl?: string;
  available?: boolean;
  credentialSecret?: string;
  recurring?: KubeObject[];
  backupVolume?: string;
  backupState?: string;
  foreignPod?: boolean;
  absent?: boolean;
}

const claimObject = (name: string, storageClassName: string, volumeName: string): KubeObject => ({
  metadata: { name, namespace: "apps", labels: { app: "pg" } },
  spec: {
    accessModes: ["ReadWriteOnce"],
    resources: { requests: { storage: "10Gi" } },
    storageClassName,
    volumeName,
  },
  status: { phase: "Bound" },
});

function cluster(o: ClusterOptions = {}): FakeK8s {
  return createFakeK8s({
    ...(o.absent ? { absentGroups: ["longhorn.io"] } : {}),
    objects: [
      {
        ref: RESOURCES.storageClasses,
        items: [
          { metadata: { name: "local-path" }, provisioner: "rancher.io/local-path" },
          { metadata: { name: "longhorn" }, provisioner: "driver.longhorn.io" },
        ] as KubeObject[],
      },
      {
        ref: RESOURCES.longhornBackupTargets,
        items: [
          {
            metadata: { name: "default", namespace: LH },
            spec: {
              backupTargetURL: o.targetUrl ?? "",
              ...(o.credentialSecret ? { credentialSecret: o.credentialSecret } : {}),
            },
            status: o.available === undefined ? {} : { available: o.available },
          },
        ],
      },
      { ref: RESOURCES.longhornRecurringJobs, items: o.recurring ?? [] },
      {
        ref: RESOURCES.longhornVolumes,
        items: [
          {
            metadata: { name: "pvc-pg", namespace: LH, labels: { "recurring-job-group.longhorn.io/old": "enabled" } },
            spec: { numberOfReplicas: 2, size: "10737418240", accessMode: "rwo", dataEngine: "v1" },
            status: { kubernetesStatus: { namespace: "apps", pvcName: "pg-data", pvName: "pvc-pg" } },
          },
        ],
      },
      {
        ref: RESOURCES.longhornBackups,
        items: [
          {
            metadata: { name: "backup-1", namespace: LH, labels: { "backup-volume": o.backupVolume ?? "pvc-pg" } },
            status: {
              state: o.backupState ?? "Completed",
              url: "nfs://nas.example.test:/backups?backup=backup-1&volume=pvc-pg",
              volumeName: o.backupVolume ?? "pvc-pg",
              volumeSize: "10737418240",
              snapshotCreatedAt: "2026-10-08T03:00:00Z",
            },
          },
        ],
      },
      {
        ref: RESOURCES.pvcs,
        items: [claimObject("pg-data", "longhorn", "pvc-pg"), claimObject("cache", "local-path", "pvc-cache")],
      },
      {
        ref: RESOURCES.pvs,
        items: [
          { metadata: { name: "pvc-pg" }, spec: { persistentVolumeReclaimPolicy: "Delete" } },
          { metadata: { name: "pvc-cache" }, spec: { persistentVolumeReclaimPolicy: "Delete" } },
        ],
      },
      {
        ref: RESOURCES.statefulSets,
        items: [
          {
            metadata: { name: "pg", namespace: "apps", labels: { "app.kubernetes.io/instance": "pg" } },
            spec: {
              replicas: 1,
              template: { spec: { volumes: [{ persistentVolumeClaim: { claimName: "pg-data" } }] } },
            },
          },
        ],
      },
      {
        ref: RESOURCES.pods,
        items: [
          {
            metadata: {
              name: "pg-0",
              namespace: "apps",
              ownerReferences: [{ apiVersion: "apps/v1", kind: "StatefulSet", name: "pg", uid: "u" }],
            },
            spec: { nodeName: "node-1", volumes: [{ persistentVolumeClaim: { claimName: "pg-data" } }] },
          },
          ...(o.foreignPod
            ? [
                {
                  metadata: { name: "debug", namespace: "apps" },
                  spec: { volumes: [{ persistentVolumeClaim: { claimName: "pg-data" } }] },
                },
              ]
            : []),
        ],
      },
    ],
  });
}

function context(k8s: FakeK8s, overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    run: true,
    enabled: true,
    image: "img",
    call: () => Promise.reject(new Error("no calls here")),
    k8s,
    discover: async () => undefined,
    releases: [],
    versions: new Map([["longhorn", "1.13.0"]]),
    storageTargets: createMockStorageTargets(),
    ...overrides,
  };
}

async function render(request: DeployActionRequest, ctx: ActionContext): Promise<ActionRendered> {
  assert.ok(actionSchema.safeParse(request).success, `schema refuses ${JSON.stringify(request)}`);
  const recipe = actionRecipe(request.kind);
  assert.ok(recipe, `no recipe for ${request.kind}`);
  return recipe.render(request as never, ctx);
}

const argv = (r: ActionRendered) => r.steps.map((s) => s.argv.join(" "));

test("longhorn-target applies the S3 credentials as a file and points the target at the connector", async () => {
  const r = await render({ kind: "longhorn-target", connectorId: "cn_st2" }, context(cluster()));
  assert.equal(r.plan.allowed, true, r.plan.blockedBy);
  assert.equal(r.release, "longhorn");
  assert.equal(r.version, "1.13.0");
  assert.deepEqual(JSON.parse(r.files["patch.yaml"]!), {
    spec: { backupTargetURL: "s3://cluster-backups@us-east-1/", credentialSecret: "test-backup-cn_st2" },
  });
  assert.equal(JSON.parse(r.files["secret.json"]!).stringData.AWS_SECRET_ACCESS_KEY, MOCK_STORAGE_SECRET_VALUE);
  assert.ok(r.secrets!.includes(MOCK_STORAGE_SECRET_VALUE));
  assert.ok(!JSON.stringify(r.plan).includes(MOCK_STORAGE_SECRET_VALUE));
  assert.deepEqual(argv(r)[0], `kubectl apply -f /values/secret.json`);
  assert.ok(argv(r).at(-1)!.startsWith("kubectl wait backuptargets.longhorn.io/default"));
  assert.ok(r.plan.creates.some((c) => c.kind === "Secret" && c.name === "test-backup-cn_st2"));
});

test("a plan carries no credential file; an NFS target needs none and drops the previous one of ours", async () => {
  const k8s = cluster({ targetUrl: "s3://old@x/", credentialSecret: `${prefix}backup-cn_old` });
  const plan = await render({ kind: "longhorn-target", connectorId: "cn_st2" }, context(k8s, { run: false }));
  assert.equal(plan.files["secret.json"], undefined);

  const r = await render({ kind: "longhorn-target", connectorId: "cn_st1" }, context(k8s));
  assert.equal(r.files["secret.json"], undefined);
  assert.equal(JSON.parse(r.files["patch.yaml"]!).spec.credentialSecret, "");
  assert.ok(argv(r).includes(`kubectl delete secret ${prefix}backup-cn_old --namespace ${LH} --ignore-not-found`));
});

test("clearing the target leaves someone else's credential Secret alone", async () => {
  const r = await render(
    { kind: "longhorn-target", connectorId: null },
    context(cluster({ targetUrl: "s3://b@r/", credentialSecret: "their-secret" }))
  );
  assert.equal(r.plan.allowed, true);
  assert.deepEqual(JSON.parse(r.files["patch.yaml"]!), { spec: { backupTargetURL: "", credentialSecret: "" } });
  assert.ok(!argv(r).some((a) => a.includes("delete secret")));
});

test("longhorn-target refuses an unknown target, deploys off, and a cluster without Longhorn", async () => {
  const unknown = await render({ kind: "longhorn-target", connectorId: "cn_nope" }, context(cluster()));
  assert.match(unknown.plan.blockedBy!, /No storage target "cn_nope"/);
  const off = await render({ kind: "longhorn-target", connectorId: "cn_st1" }, context(cluster(), { enabled: false }));
  assert.match(off.plan.blockedBy!, /Deploys are off/);
  const absent = await render({ kind: "longhorn-target", connectorId: "cn_st1" }, context(cluster({ absent: true })));
  assert.match(absent.plan.blockedBy!, /Longhorn is not installed/);
});

test("longhorn-recurring writes one job per half of each group and removes only its own stale ones", async () => {
  const k8s = cluster({
    recurring: [
      { metadata: { name: `${prefix}weekly-backup`, namespace: LH, labels: owned }, spec: { groups: ["weekly"] } },
      { metadata: { name: "someone-elses", namespace: LH }, spec: { groups: ["x"] } },
    ],
  });
  const r = await render(
    {
      kind: "longhorn-recurring",
      schedules: [
        { group: "default", snapshotCron: "0 * * * *", snapshotRetain: 24, backupCron: "0 3 * * *" },
        { group: "critical", backupCron: "0 */6 * * *", backupRetain: 28 },
      ],
    },
    context(k8s)
  );
  assert.equal(r.plan.allowed, true, r.plan.blockedBy);
  const jobs = JSON.parse(r.files["recurring.json"]!).items as Array<{
    metadata: { name: string };
    spec: Record<string, unknown>;
  }>;
  assert.deepEqual(
    jobs.map((j) => [j.metadata.name, j.spec.task, j.spec.cron, j.spec.retain, j.spec.groups]),
    [
      [`${prefix}default-snapshot`, "snapshot", "0 * * * *", 24, ["default"]],
      [`${prefix}default-backup`, "backup", "0 3 * * *", 14, ["default"]],
      [`${prefix}critical-backup`, "backup", "0 */6 * * *", 28, ["critical"]],
    ]
  );
  assert.ok(
    argv(r).includes(
      `kubectl delete recurringjobs.longhorn.io ${prefix}weekly-backup --namespace ${LH} --ignore-not-found`
    )
  );
  assert.ok(!argv(r).some((a) => a.includes("someone-elses")));
});

test("longhorn-recurring moves a volume into exactly the asked groups", async () => {
  const r = await render(
    { kind: "longhorn-recurring", volumes: [{ namespace: "apps", claim: "pg-data", groups: ["critical"] }] },
    context(cluster())
  );
  assert.deepEqual(
    argv(r)[0],
    [
      `kubectl label volumes.longhorn.io pvc-pg --namespace ${LH} --overwrite`,
      "recurring-job-group.longhorn.io/critical=enabled recurring-job-group.longhorn.io/old-",
    ].join(" ")
  );
  const back = await render(
    { kind: "longhorn-recurring", volumes: [{ namespace: "apps", claim: "pg-data", groups: [] }] },
    context(cluster())
  );
  assert.ok(argv(back)[0]!.endsWith("--overwrite recurring-job-group.longhorn.io/old-"));
  const notLonghorn = await render(
    { kind: "longhorn-recurring", volumes: [{ namespace: "apps", claim: "cache", groups: [] }] },
    context(cluster())
  );
  assert.match(notLonghorn.plan.blockedBy!, /not a Longhorn volume/);
});

test("the schema refuses a bad group or cron before anything renders", () => {
  assert.equal(
    actionSchema.safeParse({ kind: "longhorn-recurring", schedules: [{ group: "Bad Group", backupCron: "0 3 * * *" }] })
      .success,
    false
  );
  assert.equal(
    actionSchema.safeParse({ kind: "longhorn-recurring", schedules: [{ group: "ok", backupCron: "daily" }] }).success,
    false
  );
});

test("backup now needs a reachable target, then snapshots and backs up the claim's volume", async () => {
  const none = await render({ kind: "longhorn-backup-now", namespace: "apps", claim: "pg-data" }, context(cluster()));
  assert.match(none.plan.blockedBy!, /no backup target/);
  const down = await render(
    { kind: "longhorn-backup-now", namespace: "apps", claim: "pg-data" },
    context(cluster({ targetUrl: "nfs://nas:/b", available: false }))
  );
  assert.match(down.plan.blockedBy!, /can't reach its backup target/);
  const r = await render(
    { kind: "longhorn-backup-now", namespace: "apps", claim: "pg-data" },
    context(cluster({ targetUrl: "nfs://nas:/b", available: true }))
  );
  assert.equal(r.plan.allowed, true);
  const snapshot = JSON.parse(r.files["snapshot.json"]!);
  const backup = JSON.parse(r.files["backup.json"]!);
  assert.equal(snapshot.spec.volume, "pvc-pg");
  assert.equal(backup.spec.snapshotName, snapshot.metadata.name);
  assert.equal(backup.metadata.labels["backup-volume"], "pvc-pg");
});

test("restore to a new claim makes a volume from the backup and binds a new claim to it", async () => {
  const r = await render(
    {
      kind: "longhorn-restore",
      namespace: "apps",
      claim: "pg-data",
      backup: "backup-1",
      mode: "new-pvc",
      newClaim: "pg-restored",
    },
    context(cluster())
  );
  assert.equal(r.plan.allowed, true, r.plan.blockedBy);
  const volume = JSON.parse(r.files["volume.json"]!);
  const pv = JSON.parse(r.files["pv.json"]!);
  const claim = JSON.parse(r.files["claim.json"]!);
  assert.equal(volume.spec.fromBackup, "nfs://nas.example.test:/backups?backup=backup-1&volume=pvc-pg");
  assert.equal(volume.spec.size, "10737418240");
  assert.equal(volume.spec.numberOfReplicas, 2);
  assert.equal(pv.spec.csi.volumeHandle, volume.metadata.name);
  assert.equal(pv.spec.persistentVolumeReclaimPolicy, "Retain");
  assert.deepEqual(
    [claim.metadata.name, claim.spec.volumeName, claim.spec.storageClassName],
    ["pg-restored", volume.metadata.name, "longhorn"]
  );
  assert.equal(JSON.parse(r.files["plan.json"]!).mode, "new-pvc");
  assert.equal(r.plan.downtime, undefined);
  assert.equal(r.files["old.json"], undefined);
});

test("restore in place stops what mounts the claim and keeps the old volume to fall back on", async () => {
  const r = await render(
    { kind: "longhorn-restore", namespace: "apps", claim: "pg-data", backup: "backup-1", mode: "in-place" },
    context(cluster())
  );
  assert.equal(r.plan.allowed, true, r.plan.blockedBy);
  const plan = JSON.parse(r.files["plan.json"]!);
  assert.deepEqual(plan.workloads, [{ kind: "statefulset", name: "pg", replicas: 1 }]);
  assert.equal(plan.oldPv, "pvc-pg");
  assert.equal(JSON.parse(r.files["claim.json"]!).metadata.name, "pg-data");
  assert.equal(JSON.parse(r.files["old.json"]!).spec.volumeName, "pvc-pg");
  assert.match(r.plan.downtime!, /pg is stopped/);
});

test("restore refuses another volume's backup, an unfinished one, a taken name and a pod it can't stop", async () => {
  const req = { kind: "longhorn-restore", namespace: "apps", claim: "pg-data", backup: "backup-1" } as const;
  const other = await render(
    { ...req, mode: "new-pvc", newClaim: "x" },
    context(cluster({ backupVolume: "pvc-other" }))
  );
  assert.match(other.plan.blockedBy!, /is of volume pvc-other/);
  const running = await render(
    { ...req, mode: "new-pvc", newClaim: "x" },
    context(cluster({ backupState: "InProgress" }))
  );
  assert.match(running.plan.blockedBy!, /not complete/);
  const taken = await render({ ...req, mode: "new-pvc", newClaim: "cache" }, context(cluster()));
  assert.match(taken.plan.blockedBy!, /already exists/);
  const foreign = await render({ ...req, mode: "in-place" }, context(cluster({ foreignPod: true })));
  assert.match(foreign.plan.blockedBy!, /Pod debug also mounts pg-data/);
});

test("migrate-storage to local-path moves the app's Longhorn volumes and says what that gives up", async () => {
  const ctx = context(cluster(), {
    releases: [{ appId: "pg", release: "pg", namespace: "apps", jobId: "dj_1", state: "succeeded" }],
  });
  const r = await render({ kind: "migrate-storage", appId: "pg", to: "local-path" }, ctx);
  assert.equal(r.plan.allowed, true, r.plan.blockedBy);
  assert.equal(r.plan.kind, "migrate-storage");
  assert.equal(r.plan.title, "Move pg to local-path");
  assert.deepEqual(
    r.plan.volumes!.map((v) => [v.claim, v.storageClass, v.targetStorageClass, v.node]),
    [["pg-data", "longhorn", "local-path", "node-1"]]
  );
  assert.ok(r.plan.creates.some((c) => c.name === "pg-data-local-path"));
  assert.ok(r.plan.warnings.some((w) => /one node's disk/.test(w)));
  assert.equal(r.plan.offerReplicas, false);
  const plan = JSON.parse(r.files["plan.json"]!);
  assert.deepEqual([plan.from, plan.to], ["Longhorn", "local-path"]);

  const back = await render({ kind: "migrate-storage", appId: "pg", to: "longhorn" }, ctx);
  assert.match(back.plan.blockedBy!, /no local-path volumes|None of its volumes are on local-path/);
});

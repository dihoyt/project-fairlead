import { test } from "node:test";
import assert from "node:assert/strict";
import { loadYaml } from "@kubernetes/client-node";
import type { DeployActionRequest } from "../../../src/contracts/deploy.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { createMockStorageTargets } from "../../../src/contracts/mocks/connectors/storage.js";
import { MOCK_STORAGE_SECRET_VALUE } from "../../../src/contracts/mocks/connectors/storage.js";
import { createFakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { pgClusterLabel, pgClusterName, pgAppLabel, pgSecretAnnotation } from "../../../src/contracts/postgres.js";
import {
  actionRecipe,
  actionSchema,
  type ActionContext,
  type ActionRendered,
} from "../../../src/modules/deploy/actions/index.js";
import { DUMP_NAME, STORE_NAME, archivePath, sixField } from "../../../src/modules/deploy/actions/pg-backup-objects.js";
import { product } from "../../../src/product.js";

const domain = product.ownerMarker.labelDomain;
const NS = "postgres";
const CURRENT = pgClusterName(product.slug);
const IMAGE = "ghcr.io/cloudnative-pg/postgresql:17.6";
const WAL = "barman-cloud.cloudnative-pg.io";

type Obj = Record<string, unknown> & KubeObject;

function cluster(name: string, options: { label?: string; archiving?: boolean } = {}): Obj {
  return {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: { name, namespace: NS, labels: options.label ? { [pgClusterLabel(domain)]: options.label } : {} },
    spec: {
      instances: 2,
      enableSuperuserAccess: true,
      storage: { size: "20Gi", storageClass: "longhorn" },
      ...(options.archiving
        ? {
            plugins: [
              { name: WAL, isWALArchiver: true, parameters: { barmanObjectName: STORE_NAME, serverName: name } },
            ],
          }
        : {}),
    },
    status: { image: IMAGE, readyInstances: 2 },
  };
}

const appDb = (clusterName: string, appId: string, ns: string): Obj => ({
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "Database",
  metadata: {
    name: `${clusterName}-${appId}`,
    namespace: NS,
    labels: { [pgAppLabel(domain)]: appId },
    annotations: { [pgSecretAnnotation(domain)]: `${ns}/${appId}-postgres` },
  },
  spec: { cluster: { name: clusterName }, name: appId, owner: appId },
});

function fake(
  objects: {
    clusters?: Obj[];
    stores?: Obj[];
    jobs?: Obj[];
    crons?: Obj[];
    databases?: Obj[];
    longhornUrl?: string;
  } = {},
  absent: string[] = []
) {
  return createFakeK8s({
    objects: [
      { ref: RESOURCES.cnpgClusters, items: objects.clusters ?? [cluster(CURRENT)] },
      { ref: RESOURCES.barmanObjectStores, items: objects.stores ?? [] },
      { ref: RESOURCES.cnpgScheduledBackups, items: [] },
      { ref: RESOURCES.cnpgDatabases, items: objects.databases ?? [] },
      { ref: RESOURCES.cnpgDatabaseRoles, items: [] },
      { ref: RESOURCES.cronJobs, items: objects.crons ?? [] },
      { ref: RESOURCES.jobs, items: objects.jobs ?? [] },
      {
        ref: RESOURCES.longhornBackupTargets,
        items:
          objects.longhornUrl === undefined
            ? []
            : [
                {
                  apiVersion: "longhorn.io/v1beta2",
                  kind: "BackupTarget",
                  metadata: { name: "default", namespace: "longhorn-system" },
                  spec: { backupTargetURL: objects.longhornUrl },
                } as KubeObject,
              ],
      },
    ],
    absentGroups: absent,
  });
}

function context(k8s: ReturnType<typeof fake>, overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    run: true,
    enabled: true,
    image: "img",
    call: () => Promise.reject(new Error("no calls here")),
    k8s,
    discover: async () => undefined,
    releases: [{ appId: "grafana", release: "grafana", namespace: "monitoring", jobId: "dj_1", state: "succeeded" }],
    versions: new Map(),
    storageTargets: createMockStorageTargets(),
    ...overrides,
  };
}

async function action(request: DeployActionRequest, ctx: ActionContext): Promise<ActionRendered> {
  assert.ok(actionSchema.safeParse(request).success, `schema refuses ${JSON.stringify(request)}`);
  return actionRecipe(request.kind)!.render(request as never, ctx);
}

const items = (file: string | undefined) => (loadYaml(file!) as { items: Obj[] }).items;
const commands = (r: ActionRendered) => r.steps.map((s) => s.argv.join(" "));

test("archive path: the bucket without its region, under the target's prefix", () => {
  assert.equal(archivePath({ url: "s3://cluster-backups@us-east-1/" }), "s3://cluster-backups/postgres/");
  assert.equal(archivePath({ url: "s3://b@r/site-a/" }), "s3://b/site-a/postgres/");
  assert.equal(archivePath({ url: "nfs://nas:/x" }), undefined);
  assert.equal(sixField("0 2 * * *"), "0 0 2 * * *");
});

test("pg-backups to S3: store with the credentials by reference, archiver on, schedule; secrets kept out of the log", async () => {
  const r = await action(
    { kind: "pg-backups", connectorId: "cn_st2", schedule: "30 1 * * *", retention: 30 },
    context(fake())
  );
  assert.equal(r.plan.allowed, true, r.plan.blockedBy);
  assert.equal(r.release, "postgres");
  const [store] = items(r.files["store.yaml"]);
  assert.equal(store!.kind, "ObjectStore");
  const spec = store!.spec as { retentionPolicy: string; configuration: Record<string, unknown> };
  assert.equal(spec.retentionPolicy, "30d");
  assert.equal(spec.configuration.destinationPath, "s3://cluster-backups/postgres/");
  assert.equal(spec.configuration.endpointURL, "https://minio.example.test:9000");
  assert.deepEqual(spec.configuration.s3Credentials, {
    accessKeyId: { name: "test-backup-cn_st2", key: "AWS_ACCESS_KEY_ID" },
    secretAccessKey: { name: "test-backup-cn_st2", key: "AWS_SECRET_ACCESS_KEY" },
  });
  assert.doesNotMatch(r.files["store.yaml"]!, new RegExp(MOCK_STORAGE_SECRET_VALUE));
  assert.ok(r.secrets!.includes(MOCK_STORAGE_SECRET_VALUE));
  assert.match(r.files["secret.json"]!, /"namespace":"postgres"/);

  const patch = loadYaml(r.files["archiver.yaml"]!) as {
    spec: { plugins: Array<{ parameters: Record<string, string> }> };
  };
  assert.deepEqual(patch.spec.plugins[0]!.parameters, { barmanObjectName: STORE_NAME, serverName: CURRENT });
  const [schedule] = items(r.files["schedule.yaml"]);
  assert.deepEqual((schedule!.spec as Record<string, unknown>).schedule, "0 30 1 * * *");
  assert.deepEqual((schedule!.spec as Record<string, unknown>).cluster, { name: CURRENT });
  assert.ok(commands(r).some((c) => c.includes("--for=condition=ContinuousArchiving")));
  assert.match(r.plan.downtime!, /restarts once/);

  const plan = await action({ kind: "pg-backups", connectorId: "cn_st2" }, context(fake(), { run: false }));
  assert.equal(plan.files["secret.json"], undefined);
  assert.deepEqual(plan.secrets, []);
});

test("pg-backups to S3 is refused without the Barman Cloud plugin", async () => {
  const r = await action({ kind: "pg-backups", connectorId: "cn_st2" }, context(fake({}, ["barmancloud.cnpg.io"])));
  assert.match(r.plan.blockedBy!, /Barman Cloud plugin/);
});

test("pg-backups to NFS: dumps only through Longhorn's own target", async () => {
  const elsewhere = await action({ kind: "pg-backups", connectorId: "cn_st1" }, context(fake({ longhornUrl: "" })));
  assert.match(elsewhere.plan.blockedBy!, /set Longhorn's backup target to NAS backups first/);
  const noLonghorn = await action({ kind: "pg-backups", connectorId: "cn_st1" }, context(fake({}, ["longhorn.io"])));
  assert.match(noLonghorn.plan.blockedBy!, /Longhorn, which is not installed/);

  const r = await action(
    { kind: "pg-backups", connectorId: "cn_st1", retention: 7 },
    context(fake({ longhornUrl: "nfs://nas.example.test:/volume1/backups/cluster/" }))
  );
  assert.equal(r.plan.allowed, true, r.plan.blockedBy);
  const [claim, cron] = items(r.files["dumps.yaml"]);
  assert.equal(claim!.kind, "PersistentVolumeClaim");
  assert.equal(claim!.metadata.labels!["recurring-job-group.longhorn.io/critical"], "enabled");
  assert.equal(claim!.metadata.labels!["recurring-job.longhorn.io/source"], "enabled");
  assert.deepEqual((claim!.spec as { resources: unknown }).resources, { requests: { storage: "20Gi" } });
  const spec = cron!.spec as {
    schedule: string;
    successfulJobsHistoryLimit: number;
    jobTemplate: {
      spec: { template: { spec: { containers: Array<{ image: string; env: Array<{ name: string }> }> } } };
    };
  };
  assert.equal(cron!.metadata.name, DUMP_NAME);
  assert.equal(spec.schedule, "0 2 * * *");
  assert.equal(spec.successfulJobsHistoryLimit, 7);
  const container = spec.jobTemplate.spec.template.spec.containers[0]!;
  assert.equal(container.image, IMAGE);
  assert.deepEqual(
    container.env.map((e) => e.name),
    ["PGHOST", "PGUSER", "PGPASSWORD", "KEEP", "JOB"]
  );
  assert.equal(r.plan.downtime, undefined);

  const tooMany = await action(
    { kind: "pg-backups", connectorId: "cn_st1", retention: 90 },
    context(fake({ longhornUrl: "nfs://nas.example.test:/volume1/backups/cluster/" }))
  );
  assert.match(tooMany.plan.blockedBy!, /at most 60/);
});

test("switching from point-in-time to dumps takes the archiver off; turning off removes the CronJob", async () => {
  const k8s = fake({
    clusters: [cluster(CURRENT, { archiving: true })],
    longhornUrl: "nfs://nas.example.test:/volume1/backups/cluster/",
  });
  const r = await action({ kind: "pg-backups", connectorId: "cn_st1" }, context(k8s));
  assert.equal(r.plan.allowed, true, r.plan.blockedBy);
  assert.deepEqual(loadYaml(r.files["no-archiver.yaml"]!), { spec: { plugins: null } });
  assert.ok(commands(r).some((c) => c.startsWith(`kubectl delete objectstores.barmancloud.cnpg.io ${STORE_NAME}`)));

  const dumping = fake({
    crons: [{ apiVersion: "batch/v1", kind: "CronJob", metadata: { name: DUMP_NAME, namespace: NS } }],
  });
  const off = await action({ kind: "pg-backups", connectorId: null }, context(dumping));
  assert.deepEqual(commands(off), [`kubectl delete cronjob ${DUMP_NAME} --namespace postgres --ignore-not-found`]);
  const already = await action({ kind: "pg-backups", connectorId: null }, context(fake()));
  assert.match(already.plan.blockedBy!, /already off/);
});

test("pg-backup-now: a Backup object for point-in-time, a Job from the CronJob for dumps", async () => {
  const pitr = await action(
    { kind: "pg-backup-now" },
    context(fake({ clusters: [cluster(CURRENT, { archiving: true })] }))
  );
  const [backup] = items(pitr.files["backup.yaml"]);
  assert.equal(backup!.kind, "Backup");
  assert.deepEqual((backup!.spec as Record<string, unknown>).method, "plugin");

  const dumping = fake({
    crons: [{ apiVersion: "batch/v1", kind: "CronJob", metadata: { name: DUMP_NAME, namespace: NS } }],
  });
  const dump = await action({ kind: "pg-backup-now" }, context(dumping));
  assert.match(commands(dump)[0]!, new RegExp(`^kubectl create job ${DUMP_NAME}-\\d{12} --from=cronjob/${DUMP_NAME}`));

  const off = await action({ kind: "pg-backup-now" }, context(fake()));
  assert.match(off.plan.blockedBy!, /backups are off/);
});

const recoveryWindow = (first: string): Obj => ({
  apiVersion: "barmancloud.cnpg.io/v1",
  kind: "ObjectStore",
  metadata: { name: STORE_NAME, namespace: NS },
  status: { serverRecoveryWindow: { [CURRENT]: { firstRecoverabilityPoint: first } } },
});

test("pg-restore to a moment: a new cluster recovered from the old one's archive, apps moved, old one hibernated", async () => {
  const k8s = fake({
    clusters: [cluster(CURRENT, { label: "current", archiving: true })],
    stores: [recoveryWindow("2026-10-01T00:00:00Z")],
    databases: [appDb(CURRENT, "authentik", "authentik"), appDb(CURRENT, "grafana", "monitoring")],
  });
  const early = await action({ kind: "pg-restore", at: "2026-09-30T00:00:00Z" }, context(k8s));
  assert.match(early.plan.blockedBy!, /earliest moment to restore to is 2026-10-01T00:00:00Z/);
  const both = await action({ kind: "pg-restore", at: "2026-10-06T10:42:00Z", dumpId: "x" }, context(k8s));
  assert.match(both.plan.blockedBy!, /exactly one/);

  const r = await action({ kind: "pg-restore", at: "2026-10-06T10:42:00Z" }, context(k8s));
  assert.equal(r.plan.allowed, true, r.plan.blockedBy);
  const name = `${CURRENT}-r202610061042`;
  assert.equal(r.plan.title, "Restore Postgres to 2026-10-06 10:42 UTC");
  const [restored] = items(r.files["cluster.yaml"]);
  assert.equal(restored!.metadata.name, name);
  assert.equal(restored!.metadata.labels?.[pgClusterLabel(domain)], undefined);
  const spec = restored!.spec as Record<string, unknown>;
  assert.deepEqual(spec.bootstrap, {
    recovery: { source: "origin", recoveryTarget: { targetTime: "2026-10-06T10:42:00.000Z" } },
  });
  assert.deepEqual(spec.externalClusters, [
    { name: "origin", plugin: { name: WAL, parameters: { barmanObjectName: STORE_NAME, serverName: CURRENT } } },
  ]);
  assert.deepEqual((spec.plugins as Array<{ parameters: unknown }>)[0]!.parameters, {
    barmanObjectName: STORE_NAME,
    serverName: name,
  });
  assert.deepEqual(spec.storage, { size: "20Gi", storageClass: "longhorn" });

  // The apps' Secrets point at the new cluster, with new passwords kept out of the log.
  const grafana = items(r.files["postgres-grafana.yaml"]).find((o) => o.metadata.namespace === "monitoring")!;
  assert.equal((grafana.stringData as Record<string, string>).host, `${name}-rw.postgres.svc`);
  assert.equal(r.secrets!.length, 2);

  const c = commands(r);
  const at = (prefix: string) => c.findIndex((x) => x.startsWith(prefix));
  assert.ok(
    at(`kubectl wait clusters.postgresql.cnpg.io/${name}`) < at("kubectl apply -f /values/postgres-authentik.yaml")
  );
  assert.ok(
    c.includes(
      "kubectl rollout restart deployment --namespace monitoring --selector app.kubernetes.io/instance=grafana"
    )
  );
  assert.ok(at("kubectl rollout restart") < at(`kubectl label clusters.postgresql.cnpg.io/${CURRENT}`));
  assert.ok(
    c.includes(
      `kubectl label clusters.postgresql.cnpg.io/${name} --namespace postgres ${pgClusterLabel(domain)}=current --overwrite`
    )
  );
  assert.ok(
    c.includes(
      `kubectl annotate clusters.postgresql.cnpg.io/${CURRENT} --namespace postgres cnpg.io/hibernation=on --overwrite`
    )
  );
  assert.equal(r.deadlineSeconds, 3 * 3600);
});

test("pg-restore from a dump: a new cluster loaded from the dump's file", async () => {
  const job: Obj = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: `${DUMP_NAME}-29330520`, namespace: NS },
    status: { succeeded: 1, completionTime: "2026-10-07T02:03:00Z" },
  };
  const k8s = fake({
    clusters: [cluster(CURRENT, { label: "current" })],
    crons: [
      {
        apiVersion: "batch/v1",
        kind: "CronJob",
        metadata: { name: DUMP_NAME, namespace: NS },
        spec: { schedule: "0 3 * * *", successfulJobsHistoryLimit: 5 },
      },
    ],
    jobs: [job],
  });
  const missing = await action({ kind: "pg-restore", dumpId: "nope" }, context(k8s));
  assert.match(missing.plan.blockedBy!, /No finished dump/);
  const r = await action({ kind: "pg-restore", dumpId: job.metadata.name }, context(k8s));
  assert.equal(r.plan.allowed, true, r.plan.blockedBy);
  const [load] = items(r.files["load.yaml"]);
  const env = (
    load!.spec as { template: { spec: { containers: Array<{ env: Array<{ name: string; value?: string }> }> } } }
  ).template.spec.containers[0]!.env;
  assert.equal(env.find((e) => e.name === "DUMP")!.value, job.metadata.name);
  const [cron] = items(r.files["dumps.yaml"]);
  assert.equal((cron!.spec as { schedule: string }).schedule, "0 3 * * *");
  assert.match(r.plan.title, /dump of 2026-10-07 02:03 UTC/);
});

test("pg-remove-cluster: only a cluster a restore replaced", async () => {
  const k8s = fake({
    clusters: [cluster(CURRENT, { label: "previous" }), cluster(`${CURRENT}-r1`, { label: "current" })],
    databases: [appDb(CURRENT, "grafana", "monitoring")],
  });
  const now = await action({ kind: "pg-remove-cluster", name: `${CURRENT}-r1` }, context(k8s));
  assert.match(now.plan.blockedBy!, /apps use this cluster now/);
  const r = await action({ kind: "pg-remove-cluster", name: CURRENT }, context(k8s));
  assert.equal(r.plan.allowed, true, r.plan.blockedBy);
  assert.deepEqual(
    r.plan.deletes!.map((o) => `${o.kind} ${o.name}`),
    [`Database ${CURRENT}-grafana`, `Cluster ${CURRENT}`]
  );
});

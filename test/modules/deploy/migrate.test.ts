import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { DeployActionPlan, DeployJobView, VolumeBackupView } from "../../../src/contracts/deploy.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { createMockCatalogService, mockDiscovery } from "../../../src/contracts/mocks/catalog.js";
import { createMockContext, mockAdmin, mockViewer, type MockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s, type FakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import { BACKUP_PORT } from "../../../src/modules/deploy/actions/backup.js";
import { BACKUP_LABEL, MIGRATE_SCRIPT, parseQuantity } from "../../../src/modules/deploy/actions/migrate.js";
import mod, { registerDeploy } from "../../../src/modules/deploy/index.js";
import { JOB_LABEL } from "../../../src/modules/deploy/job.js";
import type { Deployer } from "../../../src/modules/deploy/runner.js";
import { listen } from "../../runtime/helpers.js";

const NS = "console";
const IMAGE = "docker.io/alpine/k8s@sha256:1111111111111111111111111111111111111111111111111111111111111111";
const GiB = 1024 ** 3;

interface Env {
  mock: MockContext;
  k8s: FakeK8s;
  deployer: Deployer;
  server: { url: string; close(): Promise<void> };
  fetched: string[];
}

let env: Env | undefined;

afterEach(async () => {
  if (!env) return;
  env.deployer.stop();
  await env.server.close();
  await env.mock.close();
  env = undefined;
});

const meta = (name: string, extra: Partial<KubeObject["metadata"]> = {}) => ({ name, namespace: "gitea", ...extra });
const instance = { "app.kubernetes.io/instance": "gitea" };

function cluster(
  options: { claimClass?: string; helmPvc?: boolean; usedBytes?: number; otherPod?: boolean } = {}
): FakeK8s {
  const pvc: KubeObject = {
    metadata: meta("gitea-shared-storage", {
      labels: instance,
      ...(options.helmPvc === false ? {} : { annotations: { "meta.helm.sh/release-name": "gitea" } }),
    }),
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: "10Gi" } },
      storageClassName: options.claimClass ?? "local-path",
      volumeName: "pvc-5d1e",
    },
    status: { phase: "Bound" },
  };
  const k8s = createFakeK8s({
    objects: [
      {
        ref: RESOURCES.storageClasses,
        items: [
          { metadata: { name: "local-path" }, provisioner: "rancher.io/local-path" },
          { metadata: { name: "longhorn" }, provisioner: "driver.longhorn.io", parameters: { numberOfReplicas: "2" } },
        ],
      },
      {
        ref: RESOURCES.deployments,
        items: [
          {
            metadata: meta("gitea", { labels: instance }),
            spec: {
              replicas: 1,
              template: { spec: { volumes: [{ persistentVolumeClaim: { claimName: "gitea-shared-storage" } }] } },
            },
          },
        ],
      },
      { ref: RESOURCES.pvcs, items: [pvc] },
      {
        ref: RESOURCES.pvs,
        items: [
          {
            metadata: { name: "pvc-5d1e" },
            spec: {
              persistentVolumeReclaimPolicy: "Delete",
              nodeAffinity: {
                required: {
                  nodeSelectorTerms: [{ matchExpressions: [{ key: "kubernetes.io/hostname", values: ["node-1"] }] }],
                },
              },
            },
          },
        ],
      },
      {
        ref: RESOURCES.pods,
        items: [
          {
            metadata: meta("gitea-7d9f-abcde", {
              ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "gitea-7d9f", uid: "u" }],
            }),
            spec: { volumes: [{ persistentVolumeClaim: { claimName: "gitea-shared-storage" } }] },
          },
          ...(options.otherPod
            ? [
                {
                  metadata: meta("debug"),
                  spec: { volumes: [{ persistentVolumeClaim: { claimName: "gitea-shared-storage" } }] },
                },
              ]
            : []),
        ],
      },
      {
        ref: RESOURCES.longhornNodes,
        items: ["node-1", "node-2"].map((name) => ({
          metadata: { name, namespace: "longhorn-system" },
          spec: { allowScheduling: true },
          status: {
            conditions: [{ type: "Schedulable", status: "True" }],
            diskStatus: { default: { storageAvailable: 50 * GiB } },
          },
        })),
      },
    ],
    raw: {
      "/api/v1/nodes/node-1/proxy/stats/summary": {
        pods: [
          {
            volume: [
              {
                usedBytes: options.usedBytes ?? 700 * 1024 ** 2,
                pvcRef: { name: "gitea-shared-storage", namespace: "gitea" },
              },
            ],
          },
        ],
      },
    },
  });
  return k8s;
}

async function setup(options: { k8s?: FakeK8s; installed?: boolean } = {}): Promise<Env> {
  const k8s = options.k8s ?? cluster();
  const discovery = {
    ...mockDiscovery,
    ingressHosts: [
      ...mockDiscovery.ingressHosts,
      {
        host: "git.example.test",
        url: "https://git.example.test",
        tls: true,
        namespace: "gitea",
        ingress: "gitea",
        service: "gitea-http",
        serviceUrl: "http://gitea-http.gitea.svc:3000",
        appId: "gitea",
      },
    ],
  };
  const mock = createMockContext("deploy", {
    migrations: mod.migrations,
    settings: { "deploy.image": IMAGE, "deploy.namespace": NS, "deploy.release": "console" },
    services: { k8s, catalog: createMockCatalogService({ discovery }) },
  });
  const fetched: string[] = [];
  const { deployer } = registerDeploy(mock.ctx, {
    now: () => MOCK_NOW,
    fetch: (async (url: string) => {
      fetched.push(String(url));
      return new Response(String(url).endsWith("/done") ? "" : "TARBYTES", { status: 200 });
    }) as typeof fetch,
  });
  if (options.installed !== false) {
    mock.ctx.db
      .prepare(
        `INSERT INTO deploy_jobs (seq, id, app_id, release, namespace, version, mode, state, started_by, created_at,
           job_namespace, job_name)
         VALUES (1, 'dj_1', 'gitea', 'gitea', 'gitea', '0.0.0-mock', 'install', 'succeeded', 'admin', ?, ?, ?)`
      )
      .run(new Date(MOCK_NOW).toISOString(), NS, "deploy-gitea-1");
  }
  const server = await listen(mock.app);
  env = { mock, k8s, deployer, server, fetched };
  return env;
}

async function api<T>(e: Env, method: string, path: string, body?: unknown, expect = 200): Promise<T> {
  const res = await fetch(`${e.server.url}/api/deploy${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as T;
  assert.equal(res.status, expect, JSON.stringify(json));
  return json;
}

const convert = { kind: "migrate-to-longhorn", appId: "gitea" };
const backup = { kind: "backup-volumes", appId: "gitea" };

test("parseQuantity reads Kubernetes sizes", () => {
  assert.equal(parseQuantity("10Gi"), 10 * GiB);
  assert.equal(parseQuantity("512Mi"), 512 * 1024 ** 2);
  assert.equal(parseQuantity("1G"), 1e9);
  assert.equal(parseQuantity("1500"), 1500);
  assert.equal(parseQuantity("lots"), undefined);
});

test("plan: volumes, downtime, the check URL and the Helm value, from reads only", async () => {
  const e = await setup();
  const plan = await api<DeployActionPlan>(e, "POST", "/actions/plan", convert);
  assert.equal(plan.allowed, true, plan.blockedBy);
  assert.equal(plan.title, "Move Gitea to Longhorn");
  assert.deepEqual(plan.volumes, [
    {
      namespace: "gitea",
      claim: "gitea-shared-storage",
      storageClass: "local-path",
      size: "10Gi",
      usedBytes: 700 * 1024 ** 2,
      node: "node-1",
      targetStorageClass: "longhorn",
    },
  ]);
  assert.match(plan.downtime!, /^Gitea is stopped for about 2 minutes while its data is copied\.$/);
  assert.match(plan.rollback!, /nothing is deleted/);
  assert.equal(plan.offerReplicas, true);
  assert.ok(plan.steps.some((s) => s.label === "Start Gitea and check http://gitea-http.gitea.svc:3000 answers"));
  const record = plan.steps.at(-1)!;
  assert.equal(record.label, "Record the longhorn storage class in the Helm release");
  assert.match(record.commands[0]!, /--version 0\.0\.0-mock .*--reuse-values --set persistence\.storageClass=longhorn/);
  assert.ok(plan.creates.some((c) => c.kind === "PersistentVolumeClaim" && c.name === "gitea-shared-storage-longhorn"));
  assert.ok(plan.creates.some((c) => c.kind === "Job" && c.namespace === NS));
  assert.equal(e.k8s.writes.length, 0, "a plan writes nothing");
});

test("plan: blocked with the reason when the app can't be converted", async () => {
  const cases: Array<[Parameters<typeof setup>[0], RegExp]> = [
    [{ installed: false }, /was not deployed from here/],
    [{ k8s: cluster({ claimClass: "longhorn" }) }, /has no local-path volumes/],
    [{ k8s: cluster({ usedBytes: 11 * GiB }) }, /holds more data than its size/],
    [{ k8s: cluster({ otherPod: true }) }, /Pod debug also mounts gitea-shared-storage/],
    [{ k8s: createFakeK8s() }, /Longhorn is not installed/],
    [
      {
        k8s: (() => {
          const k8s = cluster();
          k8s.set(RESOURCES.storageClasses, [
            { metadata: { name: "local-path" }, provisioner: "rancher.io/local-path" },
          ]);
          return k8s;
        })(),
      },
      /Longhorn is not installed/,
    ],
  ];
  for (const [options, reason] of cases) {
    const e = await setup(options);
    const plan = await api<DeployActionPlan>(e, "POST", "/actions/plan", convert);
    assert.equal(plan.allowed, false);
    assert.match(plan.blockedBy!, reason);
    e.deployer.stop();
    await e.server.close();
    await e.mock.close();
    env = undefined;
  }
});

test("run: one Job with the fixed script, the plan as files, and a long enough deadline", async () => {
  const e = await setup();
  const job = await api<DeployJobView>(e, "POST", "/actions/run", convert);
  assert.equal(job.mode, "action");
  assert.equal(job.action, "migrate-to-longhorn");
  assert.equal(job.release, "gitea");
  const created = await e.k8s.list(RESOURCES.jobs, { namespace: NS, labelSelector: `${JOB_LABEL}=${job.id}` });
  assert.ok(created !== "absent" && created.length === 1);
  const spec = created[0]!.spec as {
    activeDeadlineSeconds: number;
    template: { spec: { containers: Array<{ command: string[] }> } };
  };
  assert.equal(spec.template.spec.containers[0]!.command[2], MIGRATE_SCRIPT);
  assert.ok(spec.activeDeadlineSeconds > 900);
  const secret = (await e.k8s.list(RESOURCES.secrets, { namespace: NS })) as KubeObject[];
  const files = secret[0]!.stringData as Record<string, string>;
  const plan = JSON.parse(files["plan.json"]!) as { volumes: Array<{ claim: string; pv: string }>; checkUrl: string };
  assert.deepEqual(
    plan.volumes.map((v) => [v.claim, v.pv]),
    [["gitea-shared-storage", "pvc-5d1e"]]
  );
  assert.equal(plan.checkUrl, "http://gitea-http.gitea.svc:3000");
  const fresh = JSON.parse(files["new-0.json"]!) as KubeObject & { spec: { storageClassName: string } };
  assert.equal(fresh.metadata.name, "gitea-shared-storage");
  assert.equal(fresh.spec.storageClassName, "longhorn");
  assert.deepEqual(fresh.metadata.annotations, { "meta.helm.sh/release-name": "gitea" });
  const copy = JSON.parse(files["copy-0.json"]!) as KubeObject;
  assert.equal(copy.metadata.namespace, "gitea");
  await api(e, "POST", "/actions/run", convert, 409);
});

test("backup: a ready pod's volumes download through this server, then done stops it", async () => {
  const e = await setup();
  const plan = await api<DeployActionPlan>(e, "POST", "/actions/plan", backup);
  assert.equal(plan.allowed, true, plan.blockedBy);
  assert.equal(plan.title, "Back up Gitea's volumes");
  const job = await api<DeployJobView>(e, "POST", "/actions/run", backup);
  assert.equal(job.action, "backup-volumes");

  const preparing = await api<VolumeBackupView>(e, "GET", `/actions/backups/${job.id}`);
  assert.equal(preparing.state, "preparing");

  // The installer Job finished and its pod serves.
  e.mock.ctx.db.prepare("UPDATE deploy_jobs SET state = 'succeeded' WHERE id = ?").run(job.id);
  const secret = ((await e.k8s.list(RESOURCES.secrets, { namespace: NS })) as KubeObject[])[0]!;
  const files = secret.stringData as Record<string, string>;
  const run = JSON.parse(files["backup.json"]!) as { runId: string };
  const token = (JSON.parse(files["backup-secret.json"]!) as { stringData: { token: string } }).stringData.token;
  assert.match(token, /^[0-9a-f]{48}$/);
  e.k8s.upsert(RESOURCES.pods, {
    metadata: meta("gitea-backup-x", {
      labels: { [BACKUP_LABEL]: run.runId },
      creationTimestamp: "2026-10-07T12:00:00Z",
    }),
    status: { podIP: "10.42.0.9", phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  });

  const ready = await api<VolumeBackupView>(e, "GET", `/actions/backups/${job.id}`);
  assert.equal(ready.state, "ready");
  assert.deepEqual(ready.files, [
    {
      claim: "gitea-shared-storage",
      path: `api/deploy/actions/backups/${job.id}/files/gitea-shared-storage`,
      filename: "gitea-gitea-shared-storage-2026-10-07.tar.gz",
    },
  ]);

  const res = await fetch(`${e.server.url}/${ready.files[0]!.path}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/gzip");
  assert.match(res.headers.get("content-disposition")!, /filename="gitea-gitea-shared-storage-2026-10-07\.tar\.gz"/);
  assert.equal(await res.text(), "TARBYTES");
  assert.equal(e.fetched[0], `http://10.42.0.9:${BACKUP_PORT}/${token}/gitea-shared-storage.tar.gz`);
  assert.ok(e.mock.audit.some((a) => a.action === "deploy.download-backup"));

  const missing = await fetch(`${e.server.url}/api/deploy/actions/backups/${job.id}/files/other`);
  assert.equal(missing.status, 404);

  const done = await api<VolumeBackupView>(e, "POST", `/actions/backups/${job.id}/done`);
  assert.equal(done.state, "gone");
  assert.equal(e.fetched.at(-1), `http://10.42.0.9:${BACKUP_PORT}/${token}/done`);
  const after = await api<VolumeBackupView>(e, "GET", `/actions/backups/${job.id}`);
  assert.equal(after.state, "gone");
});

test("backup: downloads need write access, and only backup jobs have downloads", async () => {
  const e = await setup();
  await api(e, "GET", "/actions/backups/dj_1", undefined, 404);
  e.mock.setUser(mockViewer);
  const res = await fetch(`${e.server.url}/api/deploy/actions/backups/dj_1/files/x`);
  assert.equal(res.status, 403);
  e.mock.setUser(mockAdmin);
  await api(e, "GET", "/actions/backups/dj_1", undefined, 404);
  await api(e, "GET", "/actions/backups/dj_99", undefined, 404);
});

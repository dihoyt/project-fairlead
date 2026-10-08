import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { LonghornReplicaAdvice } from "../../../src/contracts/backups.js";
import type { DeployActionPlan, DeployJobView } from "../../../src/contracts/deploy.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { mockReplicaAdvice, mockReplicaAdviceOk } from "../../../src/contracts/mocks/backups.js";
import { createMockCatalogService } from "../../../src/contracts/mocks/catalog.js";
import { createMockContext, type MockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s, type FakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import { settingValue } from "../../../src/modules/deploy/actions/replicas.js";
import mod, { registerDeploy } from "../../../src/modules/deploy/index.js";
import { jobManifest } from "../../../src/modules/deploy/job.js";
import { observe, summarize, type Deployer } from "../../../src/modules/deploy/runner.js";
import { listen } from "../../runtime/helpers.js";

const NS = "console";
const IMAGE = "docker.io/alpine/k8s@sha256:1111111111111111111111111111111111111111111111111111111111111111";

interface Env {
  mock: MockContext;
  k8s: FakeK8s;
  deployer: Deployer;
  server: { url: string; close(): Promise<void> };
}

let env: Env | undefined;

async function setup(options: { advice?: LonghornReplicaAdvice; k8s?: FakeK8s } = {}): Promise<Env> {
  const k8s = options.k8s ?? createFakeK8s();
  const advice = options.advice ?? mockReplicaAdvice;
  const mock = createMockContext("deploy", {
    migrations: mod.migrations,
    settings: { "deploy.image": IMAGE, "deploy.namespace": NS, "deploy.release": "console" },
    services: { k8s, catalog: createMockCatalogService() },
    calls: { "GET /api/longhorn/replicas": () => advice },
  });
  const { deployer } = registerDeploy(mock.ctx, { now: () => MOCK_NOW });
  const server = await listen(mock.app);
  env = { mock, k8s, deployer, server };
  return env;
}

afterEach(async () => {
  if (!env) return;
  env.deployer.stop();
  await env.server.close();
  await env.mock.close();
  env = undefined;
});

async function post<T>(e: Env, path: string, body: unknown, expect = 200): Promise<T> {
  const res = await fetch(`${e.server.url}/api/deploy${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T;
  assert.equal(res.status, expect, JSON.stringify(json));
  return json;
}

// Longhorn as if the deploy runner had installed it.
function installedByUs(e: Env, version = "1.9.1") {
  e.mock.ctx.db
    .prepare(
      `INSERT INTO deploy_jobs (seq, id, app_id, release, namespace, version, mode, state, started_by, created_at,
         job_namespace, job_name)
       VALUES (1, 'dj_1', 'longhorn', 'longhorn', 'longhorn-system', ?, 'install', 'succeeded', 'admin', ?, ?, ?)`
    )
    .run(version, new Date(MOCK_NOW).toISOString(), NS, "deploy-longhorn-1");
}

const replicas = { kind: "longhorn-replicas", existingVolumes: true };

test("plan: the Setting and each volume below target, the StorageClass left as a warning when not ours", async () => {
  const e = await setup();
  const plan = await post<DeployActionPlan>(e, "/actions/plan", replicas);
  assert.equal(plan.allowed, true, plan.blockedBy);
  assert.equal(plan.title, "Raise Longhorn replicas to 2");
  assert.deepEqual(
    plan.steps.map((s) => s.label),
    ["Set Longhorn's default replica count to 2", "Raise 2 existing volumes to 2 replicas"]
  );
  assert.deepEqual(plan.steps[0]!.commands, [
    "kubectl patch settings.longhorn.io default-replica-count --namespace longhorn-system --type merge " +
      "--patch-file /values/setting.yaml",
  ]);
  assert.equal(plan.steps[1]!.commands.length, 2);
  assert.deepEqual(
    plan.changes.map((c) => `${c.kind}/${c.name}`),
    ["Setting/default-replica-count", "Volume/pvc-0b7c", "Volume/pvc-91ae"]
  );
  assert.deepEqual(
    plan.creates.map((c) => `${c.kind} ${c.namespace}/${c.name}`),
    [`Job ${NS}/deploy-longhorn-1`, `Secret ${NS}/deploy-longhorn-values`]
  );
  assert.ok(plan.warnings.some((w) => w.startsWith("StorageClass longhorn gives new volumes 1 replica")));
  assert.equal(e.k8s.writes.length, 0, "a plan writes nothing");
  assert.equal(e.mock.calls[0]?.key, "GET /api/longhorn/replicas");
  assert.equal(e.mock.calls[0]?.user.id, "admin");
});

test("plan: our own Helm release is upgraded in place, so the StorageClass and Setting follow", async () => {
  const e = await setup();
  installedByUs(e);
  const plan = await post<DeployActionPlan>(e, "/actions/plan", { ...replicas, existingVolumes: false });
  assert.equal(plan.allowed, true, plan.blockedBy);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]!.label, "Set Longhorn's StorageClass and default replica count to 2");
  assert.equal(
    plan.steps[0]!.commands[0],
    "helm upgrade longhorn longhorn --repo https://charts.longhorn.io --version 1.9.1 --namespace longhorn-system " +
      "--reuse-values --values /values/replicas.yaml --wait --timeout 10m"
  );
  assert.ok(plan.changes.some((c) => c.kind === "StorageClass" && c.name === "longhorn"));
  assert.ok(!plan.warnings.some((w) => w.startsWith("StorageClass")));
  assert.ok(plan.warnings.includes("2 existing volumes keep fewer than 2 replicas."));
});

test("plan: blocked when absent, unreadable, deploys off, the count isn't the target, or nothing is below", async () => {
  const cases: Array<[Parameters<typeof setup>[0], unknown, RegExp]> = [
    [{ advice: { ...mockReplicaAdviceOk, state: "absent" } }, replicas, /not installed/],
    [
      { advice: { ...mockReplicaAdvice, state: "unknown", error: "forbidden" } },
      replicas,
      /could not be read: forbidden/,
    ],
    [{ k8s: createFakeK8s({ denied: ["create batch/jobs"] }) }, replicas, /^Deploys are off\. Turn them on with: helm/],
    [{}, { ...replicas, replicas: 3 }, /raised to 2 here/],
    [{ advice: mockReplicaAdviceOk }, replicas, /^Nothing is below 2 replicas\.$/],
    [
      { advice: { ...mockReplicaAdvice, defaultReplicaCount: 2, storageClasses: [] } },
      { ...replicas, existingVolumes: false },
      /tick them/,
    ],
    [
      {
        advice: {
          ...mockReplicaAdviceOk,
          schedulableNodes: 1,
          target: 1,
          detail: "1 schedulable node: 1 replica is all it can hold.",
        },
      },
      replicas,
      /1 replica is all/,
    ],
  ];
  for (const [options, body, reason] of cases) {
    const e = await setup(options);
    const plan = await post<DeployActionPlan>(e, "/actions/plan", body);
    assert.equal(plan.allowed, false);
    assert.match(plan.blockedBy ?? "", reason);
    assert.deepEqual(plan.creates, []);
    const refused = await post<{ error: string }>(e, "/actions/run", body, 400);
    assert.match(refused.error, reason);
    assert.equal(e.k8s.writes.length, 0);
    e.deployer.stop();
    await e.server.close();
    await e.mock.close();
    env = undefined;
  }
});

test("run: a deploy job in mode action with the patches in its values Secret; audited; one at a time", async () => {
  const k8s = createFakeK8s({
    objects: [
      {
        ref: RESOURCES.longhornSettings,
        items: [
          {
            apiVersion: "longhorn.io/v1beta2",
            kind: "Setting",
            metadata: { name: "default-replica-count", namespace: "longhorn-system" },
            value: '{"v1":"1","v2":"1"}',
          } as KubeObject,
        ],
      },
    ],
  });
  const e = await setup({ k8s });
  const view = await post<DeployJobView>(e, "/actions/run", replicas);
  assert.equal(view.mode, "action");
  assert.equal(view.action, "longhorn-replicas");
  assert.equal(view.appId, "longhorn");
  assert.equal(view.release, "longhorn");
  assert.deepEqual(view.job, { namespace: NS, name: "deploy-longhorn-1" });

  const job = (await e.k8s.get(RESOURCES.jobs, "deploy-longhorn-1", NS)) as KubeObject & {
    spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
  };
  const script = job.spec.template.spec.containers[0]!.command[2]!;
  assert.match(script, /'kubectl' 'patch' 'settings.longhorn.io' 'default-replica-count'/);
  assert.match(script, /'kubectl' 'patch' 'volumes.longhorn.io' 'pvc-0b7c'/);
  assert.match(script, /'echo' 'Longhorn raised to 2 replicas\.'\n$/);
  const secret = (await e.k8s.get(RESOURCES.secrets, "deploy-longhorn-values", NS)) as KubeObject & {
    stringData: Record<string, string>;
  };
  assert.equal(secret.stringData["setting.yaml"], 'value: "{\\"v1\\":\\"2\\",\\"v2\\":\\"2\\"}"\n');
  assert.equal(secret.stringData["volume.yaml"], "spec:\n  numberOfReplicas: 2\n");

  assert.deepEqual(e.mock.audit.at(-1), {
    actor: "admin",
    action: "deploy.start",
    target: "dj_1",
    detail: `longhorn-replicas on longhorn in longhorn-system (Job ${NS}/deploy-longhorn-1)`,
  });
  const listed = await (await fetch(`${e.server.url}/api/deploy/jobs/dj_1`)).json();
  assert.equal((listed as DeployJobView).action, "longhorn-replicas");
  assert.deepEqual(e.deployer.releases(), [], "an action is not an install");

  const busy = await post<{ error: string }>(e, "/actions/run", replicas, 409);
  assert.match(busy.error, /dj_1/);
});

test("actions: migrate-to-longhorn isn't available yet; bad bodies are 400", async () => {
  const e = await setup();
  const missing = await post<{ error: string }>(
    e,
    "/actions/plan",
    { kind: "migrate-to-longhorn", namespace: "gitea", pvc: "data-gitea-0" },
    400
  );
  assert.match(missing.error, /not available yet/);
  await post(e, "/actions/plan", { kind: "longhorn-replicas" }, 400);
  await post(e, "/actions/plan", { kind: "longhorn-replicas", existingVolumes: true, replicas: 9 }, 400);
  await post(e, "/actions/plan", { kind: "reboot-everything" }, 400);
});

test("settingValue keeps the per-engine JSON form; summarize takes an action's last line", () => {
  assert.equal(settingValue(undefined, 2), "2");
  assert.equal(settingValue("1", 2), "2");
  assert.equal(settingValue('{"v1":"1","v2":"1"}', 2), '{"v1":"2","v2":"2"}');
  assert.equal(settingValue("{broken", 2), "2");
  assert.equal(
    summarize(
      ["+ helm upgrade", "STATUS: deployed", "Longhorn raised to 2 replicas."],
      "succeeded",
      "action",
      "longhorn"
    ),
    "Longhorn raised to 2 replicas."
  );
});

test("jobManifest runs an action's own script with its deadline; observe names that deadline", () => {
  const job = jobManifest({
    id: "dj_9",
    name: "deploy-x-9",
    namespace: NS,
    release: "x",
    image: IMAGE,
    serviceAccount: "installer",
    valuesSecret: "deploy-x-values",
    steps: [],
    script: "set -eu\ntrap 'echo rollback' ERR\necho done\n",
    deadlineSeconds: 3600,
  }) as KubeObject & {
    spec: { activeDeadlineSeconds: number; template: { spec: { containers: Array<{ command: string[] }> } } };
  };
  assert.equal(job.spec.activeDeadlineSeconds, 3600);
  assert.equal(job.spec.template.spec.containers[0]!.command[2], "set -eu\ntrap 'echo rollback' ERR\necho done\n");
  const failed = {
    ...job,
    status: { conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded" }] },
  };
  assert.equal(observe(failed).message, "Stopped after 60 minutes without finishing.");
});

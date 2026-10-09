import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckView } from "../../../src/contracts/checks.js";
import type { DeployActionPlan, DeployJobView } from "../../../src/contracts/deploy.js";
import type { Events } from "../../../src/contracts/events.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { createMockCatalogService } from "../../../src/contracts/mocks/catalog.js";
import { createMockContext, type MockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s, type FakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { mockTemplatesView } from "../../../src/contracts/mocks/templates.js";
import { MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import { checksFor, REMOVE_SCRIPT, UNINSTALL_SCRIPT } from "../../../src/modules/deploy/actions/remove.js";
import mod, { registerDeploy } from "../../../src/modules/deploy/index.js";
import type { Deployer } from "../../../src/modules/deploy/runner.js";
import { product } from "../../../src/product.js";
import { listen } from "../../runtime/helpers.js";

const NS = "console";
const IMAGE = "docker.io/alpine/k8s@sha256:1111111111111111111111111111111111111111111111111111111111111111";
const TEMPLATE_KEY = `${product.ownerMarker.labelDomain}/app-template`;
const DEPLOYED_KEY = `${product.ownerMarker.labelDomain}/deployed-by`;

interface Env {
  mock: MockContext;
  k8s: FakeK8s;
  deployer: Deployer;
  server: { url: string; close(): Promise<void> };
  events: Array<Events["deploy.finished"]>;
  deleted: string[];
}

let env: Env | undefined;

const check = (id: string, label: string, target: string): CheckView => ({
  id,
  label,
  kind: "http",
  target,
  intervalMs: 60_000,
  timeoutMs: 5_000,
  tlsWarnDays: 14,
  enabled: true,
});

const obj = (kind: string, name: string, extra: Partial<KubeObject> = {}): KubeObject => ({
  apiVersion: "v1",
  kind,
  metadata: { name, namespace: "status" },
  ...extra,
});

function cluster(label = "uptime-kuma"): FakeK8s {
  return createFakeK8s({
    objects: [
      {
        ref: RESOURCES.namespaces,
        items: [
          { apiVersion: "v1", kind: "Namespace", metadata: { name: "status", labels: { [TEMPLATE_KEY]: label } } },
        ],
      },
      { ref: RESOURCES.deployments, items: [obj("Deployment", "status")] },
      { ref: RESOURCES.services, items: [obj("Service", "status")] },
      { ref: RESOURCES.ingresses, items: [obj("Ingress", "status")] },
      {
        ref: RESOURCES.pvcs,
        items: [
          obj("PersistentVolumeClaim", "status-data", {
            spec: { storageClassName: "longhorn", resources: { requests: { storage: "1Gi" } } },
          } as Partial<KubeObject>),
        ],
      },
    ],
  });
}

async function setup(options: { k8s?: FakeK8s } = {}): Promise<Env> {
  const k8s = options.k8s ?? cluster();
  const deleted: string[] = [];
  const mock = createMockContext("deploy", {
    migrations: mod.migrations,
    settings: { "deploy.image": IMAGE, "deploy.namespace": NS, "deploy.release": "console" },
    services: { k8s, catalog: createMockCatalogService() },
    calls: {
      "GET /api/templates": () => mockTemplatesView,
      "GET /api/checks": () => [
        check("chk_1", "Uptime Kuma", "https://status.example.test/"),
        check("chk_2", "Gitea", "https://git.example.test"),
      ],
      "DELETE /api/checks/:id": ({ params }) => {
        deleted.push(params!.id);
        return { ok: true };
      },
    },
  });
  const { deployer } = registerDeploy(mock.ctx, { now: () => MOCK_NOW });
  const events: Env["events"] = [];
  mock.ctx.bus.on("deploy.finished", (payload) => void events.push(payload));
  const server = await listen(mock.app);
  env = { mock, k8s, deployer, server, events, deleted };
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

function installed(e: Env) {
  e.mock.ctx.db
    .prepare(
      `INSERT INTO deploy_jobs (seq, id, app_id, release, namespace, version, mode, state, started_by, created_at,
         job_namespace, job_name)
       VALUES (1, 'dj_1', 'status', 'status', 'status', '1.23.15', 'install', 'succeeded', 'admin', ?, ?, ?)`
    )
    .run(new Date(MOCK_NOW).toISOString(), NS, "deploy-status-1");
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("plan: keeps the namespace and volume by default, lists what goes and the app's check", async () => {
  const e = await setup();
  installed(e);
  const plan = await post<DeployActionPlan>(e, "/actions/plan", { kind: "remove-app", appId: "status" });
  assert.equal(plan.allowed, true, plan.blockedBy);
  assert.equal(plan.title, "Remove status");
  assert.deepEqual(
    plan.deletes?.map((d) => `${d.kind}/${d.name}`),
    ["Deployment/status", "Service/status", "Ingress/status", "Check/Uptime Kuma"]
  );
  assert.deepEqual(plan.volumes, [
    { namespace: "status", claim: "status-data", storageClass: "longhorn", size: "1Gi" },
  ]);
  assert.ok(plan.warnings.some((w) => w.startsWith("The namespace status and its volume stay")));
  assert.match(plan.rollback ?? "", /volume is still there/);
  assert.equal(e.k8s.writes.length, 0, "a plan writes nothing");
  assert.deepEqual(e.deleted, []);
});

test("plan: deleteVolumes deletes the namespace and says the data goes", async () => {
  const e = await setup();
  const plan = await post<DeployActionPlan>(e, "/actions/plan", {
    kind: "remove-app",
    appId: "status",
    deleteVolumes: true,
  });
  assert.equal(plan.allowed, true, plan.blockedBy);
  assert.ok(plan.deletes?.some((d) => d.kind === "Namespace" && d.name === "status"));
  assert.ok(plan.deletes?.some((d) => d.kind === "PersistentVolumeClaim" && d.name === "status-data"));
  assert.ok(plan.warnings.includes("The data on status-data is deleted for good."));
  assert.deepEqual(plan.steps.at(-1)!.commands, ["kubectl delete namespace status --wait=true --timeout=5m"]);
});

test("plan: blocked for a catalog app or a namespace without the template label; a gone namespace is only forgotten", async () => {
  let e = await setup();
  const gitea = await post<DeployActionPlan>(e, "/actions/plan", { kind: "remove-app", appId: "gitea" });
  assert.equal(gitea.allowed, false);
  assert.match(gitea.blockedBy ?? "", /not an app deployed from Templates/);
  const relabelled = await post<DeployActionPlan>(e, "/actions/plan", { kind: "remove-app", appId: "whoami" });
  assert.equal(relabelled.allowed, true, "an instance whose namespace is gone is only forgotten");
  assert.ok(relabelled.warnings.some((w) => w.includes("already gone")));
  await post(e, "/actions/run", { kind: "remove-app", appId: "gitea" }, 400);
  e.deployer.stop();
  await e.server.close();
  await e.mock.close();
  env = undefined;

  e = await setup({ k8s: cluster("whoami") });
  const foreign = await post<DeployActionPlan>(e, "/actions/plan", { kind: "remove-app", appId: "status" });
  assert.equal(foreign.allowed, false);
  assert.match(foreign.blockedBy ?? "", /does not carry the label/);
});

test("run: a remove-app job with the guarded script; the check goes at start; finished carries the action", async () => {
  const e = await setup();
  installed(e);
  assert.deepEqual(
    e.deployer.releases().map((r) => r.appId),
    ["status"]
  );
  const view = await post<DeployJobView>(e, "/actions/run", { kind: "remove-app", appId: "status" });
  assert.equal(view.mode, "action");
  assert.equal(view.action, "remove-app");
  assert.equal(view.release, "status");
  assert.deepEqual(e.deleted, ["chk_1"]);

  const job = (await e.k8s.get(RESOURCES.jobs, view.job.name, NS)) as KubeObject & {
    spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
  };
  assert.equal(job.spec.template.spec.containers[0]!.command[2], REMOVE_SCRIPT);
  const secret = (await e.k8s.get(RESOURCES.secrets, "deploy-status-values", NS)) as KubeObject & {
    stringData: Record<string, string>;
  };
  assert.deepEqual(secret.stringData, {
    namespace: "status",
    "template-selector": `${TEMPLATE_KEY}=uptime-kuma`,
    "deployed-selector": `${DEPLOYED_KEY}=deploy`,
    "delete-volumes": "false",
  });

  await e.deployer.ensureWatch();
  e.k8s.upsert(RESOURCES.jobs, {
    ...job,
    status: { startTime: "2026-01-01T00:00:01Z", conditions: [{ type: "Complete", status: "True" }] },
  } as KubeObject);
  await settle();
  assert.deepEqual(e.events.at(-1), {
    jobId: view.id,
    appId: "status",
    mode: "action",
    action: "remove-app",
    state: "succeeded",
  });
  assert.deepEqual(e.deployer.releases(), [], "a removed release is no longer listed");
});

test("checksFor matches http checks on the instance's host only", () => {
  const instance = mockTemplatesView.instances.find((i) => i.name === "status")!;
  const checks = [
    check("a", "a", "https://status.example.test/health"),
    check("b", "b", "https://other.example.test"),
    { ...check("c", "c", "status.example.test:443"), kind: "tcp" as const },
  ];
  assert.deepEqual(
    checksFor(instance, checks).map((c) => c.id),
    ["a"]
  );
  assert.deepEqual(checksFor({ ...instance, host: "", url: undefined }, checks), []);
});

// The real script under sh against a fake kubectl.
const hasSh = spawnSync("sh", ["-c", "command -v sh"]).status === 0;

function runScript(options: { labelled: boolean; exists: boolean; deleteVolumes: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "remove-"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "values"));
  const log = join(dir, "kubectl.log");
  writeFileSync(
    join(dir, "bin", "kubectl"),
    `#!/bin/sh
echo "$*" >> ${log}
case "$*" in
  "get namespace -l "*) ${options.labelled ? 'echo "namespace/status"' : "true"} ;;
  "get namespace "*) ${options.exists ? "true" : "exit 1"} ;;
esac
`
  );
  chmodSync(join(dir, "bin", "kubectl"), 0o755);
  const files = {
    namespace: "status",
    "template-selector": `${TEMPLATE_KEY}=uptime-kuma`,
    "deployed-selector": `${DEPLOYED_KEY}=deploy`,
    "delete-volumes": String(options.deleteVolumes),
  };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "values", name), body);
  const result = spawnSync("sh", ["-c", REMOVE_SCRIPT.replaceAll("/values/", `${dir}/values/`)], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n");
  } catch {
    // Not run.
  }
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, out: result.stdout.trim().split("\n").at(-1), calls };
}

test("script: keeps the namespace and claims unless told otherwise", { skip: !hasSh }, () => {
  const keep = runScript({ labelled: true, exists: true, deleteVolumes: false });
  assert.equal(keep.status, 0);
  assert.equal(keep.out, "Removed status; its namespace and volumes stay.");
  assert.equal(
    keep.calls[0],
    `get namespace -l ${TEMPLATE_KEY}=uptime-kuma,kubernetes.io/metadata.name=status -o name`
  );
  assert.ok(keep.calls.every((c) => !c.includes("persistentvolumeclaim") && !c.startsWith("delete namespace")));
  assert.match(keep.calls[1]!, /^delete deployment,statefulset,.*,ingress,role,rolebinding --all --namespace status/);
  assert.match(keep.calls[2]!, new RegExp(`^delete configmap,secret,serviceaccount -l ${DEPLOYED_KEY}=deploy`));

  const all = runScript({ labelled: true, exists: true, deleteVolumes: true });
  assert.equal(all.status, 0);
  assert.equal(all.calls[1], "delete namespace status --wait=true --timeout=5m");
  assert.equal(all.out, "Removed status with its namespace and volumes.");
});

test("script: refuses a namespace without the label; a gone one is fine", { skip: !hasSh }, () => {
  const foreign = runScript({ labelled: false, exists: true, deleteVolumes: true });
  assert.equal(foreign.status, 1);
  assert.ok(foreign.calls.every((c) => !c.startsWith("delete")));
  const gone = runScript({ labelled: false, exists: false, deleteVolumes: true });
  assert.equal(gone.status, 0);
  assert.equal(gone.out, "Namespace status was already gone.");
});

function giteaRelease(e: Env, state = "failed") {
  e.mock.ctx.db
    .prepare(
      `INSERT INTO deploy_jobs (seq, id, app_id, release, namespace, version, mode, state, started_by, created_at,
         job_namespace, job_name)
       VALUES (2, 'dj_2', 'gitea', 'gitea', 'gitea', '12.7.0', 'install', ?, 'admin', ?, ?, ?)`
    )
    .run(state, new Date(MOCK_NOW).toISOString(), NS, "deploy-gitea-2");
}

const claim = (name: string, instance: string): KubeObject =>
  ({
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name, namespace: "gitea", labels: { "app.kubernetes.io/instance": instance } },
    spec: { storageClassName: "local-path", resources: { requests: { storage: "5Gi" } } },
  }) as KubeObject;

function withGiteaClaims(): FakeK8s {
  const k8s = cluster();
  k8s.upsert(RESOURCES.pvcs, claim("data-gitea-0", "gitea"));
  k8s.upsert(RESOURCES.pvcs, claim("other-app", "other"));
  return k8s;
}

test("uninstall: a Helm catalog app deployed from here, keeping or deleting the release's volumes", async () => {
  const e = await setup({ k8s: withGiteaClaims() });
  giteaRelease(e);
  const keep = await post<DeployActionPlan>(e, "/actions/plan", { kind: "remove-app", appId: "gitea" });
  assert.equal(keep.allowed, true, keep.blockedBy);
  assert.equal(keep.title, "Uninstall Gitea");
  assert.deepEqual(
    keep.volumes?.map((v) => v.claim),
    ["data-gitea-0"]
  );
  assert.deepEqual(
    keep.deletes?.map((d) => `${d.kind}/${d.name}`),
    ["HelmRelease/gitea"]
  );
  assert.deepEqual(keep.steps[0]!.commands, ["helm uninstall gitea --namespace gitea --wait --timeout 5m"]);
  assert.ok(keep.warnings.some((w) => w.startsWith("data-gitea-0 stays")));

  const drop = await post<DeployActionPlan>(e, "/actions/plan", {
    kind: "remove-app",
    appId: "gitea",
    deleteVolumes: true,
  });
  assert.deepEqual(
    drop.deletes?.map((d) => `${d.kind}/${d.name}`),
    ["HelmRelease/gitea", "PersistentVolumeClaim/data-gitea-0"]
  );
  assert.ok(drop.warnings.includes("The data on data-gitea-0 is deleted for good."));

  const view = await post<DeployJobView>(e, "/actions/run", {
    kind: "remove-app",
    appId: "gitea",
    deleteVolumes: true,
  });
  assert.equal(view.release, "gitea");
  const job = (await e.k8s.get(RESOURCES.jobs, view.job.name, NS)) as KubeObject & {
    spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
  };
  assert.equal(job.spec.template.spec.containers[0]!.command[2], UNINSTALL_SCRIPT);
  const secret = (await e.k8s.get(RESOURCES.secrets, view.job.name.replace(/-\d+$/, "-values"), NS)) as KubeObject & {
    stringData: Record<string, string>;
  };
  assert.deepEqual(secret.stringData, { release: "gitea", namespace: "gitea", "delete-volumes": "true" });

  await e.deployer.ensureWatch();
  e.k8s.upsert(RESOURCES.jobs, { ...job, status: { conditions: [{ type: "Complete", status: "True" }] } });
  await settle();
  assert.deepEqual(
    e.deployer.releases().map((r) => r.appId),
    [],
    "an uninstalled release is no longer listed"
  );
});

test("uninstall: Longhorn and apps not deployed from here are refused", async () => {
  const e = await setup();
  e.mock.ctx.db
    .prepare(
      `INSERT INTO deploy_jobs (seq, id, app_id, release, namespace, version, mode, state, started_by, created_at,
         job_namespace, job_name)
       VALUES (3, 'dj_3', 'longhorn', 'longhorn', 'longhorn-system', '1.13.0', 'install', 'failed', 'admin', ?, ?, ?)`
    )
    .run(new Date(MOCK_NOW).toISOString(), NS, "deploy-longhorn-3");
  const longhorn = await post<DeployActionPlan>(e, "/actions/plan", { kind: "remove-app", appId: "longhorn" });
  assert.equal(longhorn.allowed, false);
  assert.match(longhorn.blockedBy ?? "", /every volume/);
  const headlamp = await post<DeployActionPlan>(e, "/actions/plan", { kind: "remove-app", appId: "headlamp" });
  assert.equal(headlamp.allowed, false);
});

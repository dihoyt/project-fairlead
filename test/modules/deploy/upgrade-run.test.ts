import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { DetectedApp } from "../../../src/contracts/catalog.js";
import {
  UPGRADE_RUN,
  type BundleRunView,
  type DeployJobView,
  type UpgradeReport,
} from "../../../src/contracts/deploy.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { createMockCatalogService, mockCatalog, mockDiscovery } from "../../../src/contracts/mocks/catalog.js";
import { createMockContext, type MockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s, type FakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import mod, { registerDeploy } from "../../../src/modules/deploy/index.js";
import type { Deployer } from "../../../src/modules/deploy/runner.js";
import { listen } from "../../runtime/helpers.js";

const NS = "console";
const IMAGE = "docker.io/alpine/k8s@sha256:2222222222222222222222222222222222222222222222222222222222222222";

interface Env {
  mock: MockContext;
  k8s: FakeK8s;
  deployer: Deployer;
  server: { url: string; close(): Promise<void> };
}
let env: Env | undefined;

const ours = (appId: string, chartVersion: string): DetectedApp => ({
  appId,
  state: "installed",
  namespace: appId,
  release: appId,
  chartVersion,
  urls: [`https://${appId}.example.test`],
  evidence: "mock",
  managedBy: "helm",
  ownedByUs: true,
});

async function setup(): Promise<Env> {
  const k8s = createFakeK8s();
  const apps = mockDiscovery.apps.map((app) =>
    app.appId === "gitea"
      ? ours("gitea", "0.0.0-alpha")
      : app.appId === "headlamp"
        ? ours("headlamp", "0.0.0-mock")
        : app
  );
  const mock = createMockContext("deploy", {
    migrations: mod.migrations,
    settings: { "deploy.image": IMAGE, "deploy.namespace": NS },
    services: {
      k8s,
      catalog: createMockCatalogService({ entries: mockCatalog, discovery: { ...mockDiscovery, apps } }),
    },
  });
  const { deployer } = registerDeploy(mock.ctx, { now: () => MOCK_NOW });
  const server = await listen(mock.app);
  await deployer.ensureWatch();
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

async function call<T>(e: Env, method: "GET" | "POST", path: string, body?: unknown, expect = 200): Promise<T> {
  const url = `${e.server.url}/api/deploy${path}`;
  const res =
    method === "GET"
      ? await fetch(url)
      : await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        });
  const json = (await res.json()) as T;
  assert.equal(res.status, expect, JSON.stringify(json));
  return json;
}

const state = (r: UpgradeReport) => Object.fromEntries(r.apps.map((a) => [a.appId, a.state]));

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

test("upgrade all: lists ours, runs helm upgrade keeping values, then reports current", async () => {
  const e = await setup();
  const report = await call<UpgradeReport>(e, "GET", "/upgrades");
  assert.deepEqual(state(report), { headlamp: "current", gitea: "available" });

  const refused = await call<{ error: string }>(e, "POST", "/upgrades", { appIds: ["headlamp"] }, 400);
  assert.match(refused.error, /headlamp: Already at/);
  await call(e, "POST", "/upgrades", { appIds: ["grafana"] }, 400);

  const run = await call<BundleRunView>(e, "POST", "/upgrades", {});
  assert.equal(run.bundleId, UPGRADE_RUN);
  assert.deepEqual(
    run.steps.map((s) => [s.appId, s.state]),
    [["gitea", "running"]]
  );
  const job = await call<DeployJobView>(e, "GET", `/jobs/${run.steps[0]!.jobId}`);
  assert.equal(job.mode, "upgrade");
  assert.equal(job.version, "0.0.0-mock");
  const k8sJob = (await e.k8s.get(RESOURCES.jobs, job.job.name, NS)) as KubeObject & {
    spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
  };
  const script = k8sJob.spec.template.spec.containers[0]!.command[2]!;
  assert.match(script, /helm upgrade gitea oci:\/\/docker\.gitea\.com\/charts\/gitea --version 0\.0\.0-mock/);
  assert.match(script, /--reset-then-reuse-values/);
  assert.doesNotMatch(script, /--install/);
  assert.ok(
    e.mock.audit.some(
      (a) => a.action === "deploy.start-upgrade" && /gitea 0\.0\.0-alpha -> 0\.0\.0-mock/.test(a.detail ?? "")
    )
  );

  assert.equal(state(await call<UpgradeReport>(e, "GET", "/upgrades")).gitea, "blocked");
  await call(e, "POST", "/upgrades", { appIds: ["gitea"] }, 400);

  e.k8s.upsert(RESOURCES.jobs, {
    ...k8sJob,
    status: { startTime: "2026-01-01T00:00:00Z", conditions: [{ type: "Complete", status: "True" }] },
  });
  await settle();
  const done = await call<BundleRunView>(e, "GET", `/bundles/${run.id}`);
  assert.equal(done.state, "succeeded");
  const after = await call<UpgradeReport>(e, "GET", "/upgrades");
  assert.equal(state(after).gitea, "current");
  assert.equal(after.apps.find((a) => a.appId === "gitea")!.currentVersion, "0.0.0-mock");
});

test("an app whose upgrade is running can't be upgraded again", async () => {
  const e = await setup();
  await call(e, "POST", "/upgrades", {});
  await call(e, "POST", "/upgrades", { appIds: ["gitea"] }, 400);
  await call<{ error: string }>(e, "POST", "/upgrades", {}, 400);
});

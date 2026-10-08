import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { CatalogBundle, CatalogEntry } from "../../../src/contracts/catalog.js";
import type { BundlePlan, BundleRunView, DeployJobView } from "../../../src/contracts/deploy.js";
import type { Events } from "../../../src/contracts/events.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { createMockCatalogService, mockBundle, mockCatalog } from "../../../src/contracts/mocks/catalog.js";
import { createMockContext, type MockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s, type FakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import mod, { registerDeploy } from "../../../src/modules/deploy/index.js";
import type { Deployer } from "../../../src/modules/deploy/runner.js";
import { listen } from "../../runtime/helpers.js";

const NS = "console";
const IMAGE = "docker.io/alpine/k8s@sha256:2222222222222222222222222222222222222222222222222222222222222222";
const PASSWORD = "bundle-Admin-pass";

const SERVICE = [
  "apiVersion: v1",
  "kind: Service",
  "metadata:",
  "  name: ntfy",
  "  namespace: ntfy",
  "spec:",
  "  ports:",
  "    - port: 80",
  "",
].join("\n");

const entries: CatalogEntry[] = mockCatalog.map((entry) =>
  entry.id === "ntfy" ? { ...entry, install: { kind: "manifest", bundled: SERVICE, version: "v0.0.0-mock" } } : entry
);

interface Env {
  mock: MockContext;
  k8s: FakeK8s;
  deployer: Deployer;
  server: { url: string; close(): Promise<void> };
  finished: Array<Events["deploy.bundle-finished"]>;
}
let env: Env | undefined;

async function setup(bundles?: CatalogBundle[]): Promise<Env> {
  const k8s = createFakeK8s();
  const mock = createMockContext("deploy", {
    migrations: mod.migrations,
    settings: { "deploy.image": IMAGE, "deploy.namespace": NS },
    services: { k8s, catalog: createMockCatalogService({ entries, ...(bundles ? { bundles } : {}) }) },
  });
  const { deployer } = registerDeploy(mock.ctx, { now: () => MOCK_NOW });
  const finished: Env["finished"] = [];
  mock.ctx.bus.on("deploy.bundle-finished", (payload) => void finished.push(payload));
  const server = await listen(mock.app);
  await deployer.ensureWatch();
  env = { mock, k8s, deployer, server, finished };
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
          body: body === undefined ? undefined : JSON.stringify(body),
        });
  const json = (await res.json()) as T;
  assert.equal(res.status, expect, JSON.stringify(json));
  return json;
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

const answers = { baseDomain: "example.test", adminEmail: "ops@example.test", adminPassword: PASSWORD };

async function finishJob(e: Env, jobId: string, ok: boolean) {
  const view = await call<DeployJobView>(e, "GET", `/jobs/${jobId}`);
  const job = (await e.k8s.get(RESOURCES.jobs, view.job.name, NS)) as KubeObject;
  e.k8s.upsert(RESOURCES.jobs, {
    ...job,
    status: { startTime: "2026-01-01T00:00:00Z", conditions: [{ type: ok ? "Complete" : "Failed", status: "True" }] },
  });
  await settle();
}

const states = (run: BundleRunView) => Object.fromEntries(run.steps.map((s) => [s.appId, s.state]));

test("bundle plan: order, skips with reasons, shared answers fill each app", async () => {
  const e = await setup();
  const plan = await call<BundlePlan>(e, "POST", "/bundles/plan", { bundleId: "self-hosted", inputs: answers });
  assert.equal(plan.allowed, true, JSON.stringify(plan.steps.map((s) => s.plan?.blockedBy)));
  assert.deepEqual(
    plan.steps.map((s) => `${s.appId}${s.skip ? " (skip)" : ""}`),
    [
      "traefik (skip)",
      "cert-manager (skip)",
      "metrics-server",
      "local-path-provisioner (skip)",
      "longhorn (skip)",
      "authentik",
      "gitea",
      "grafana (skip)",
      "headlamp",
      "ntfy",
    ]
  );
  const step = (id: string) => plan.steps.find((s) => s.appId === id)!;
  assert.match(step("traefik").reason ?? "", /^Already installed/);
  assert.equal(step("local-path-provisioner").reason, "The cluster already has what it provides");
  assert.equal(step("longhorn").reason, "Every node needs open-iscsi; tick it once yours do.");
  assert.deepEqual(step("gitea").plan?.inputs, {
    host: "git.example.test",
    adminUser: "gitea-admin",
    adminPassword: "********",
  });
  assert.equal(step("authentik").plan?.inputs.host, "auth.example.test");
  assert.equal(step("authentik").plan?.inputs.adminEmail, "ops@example.test");
  assert.equal(step("ntfy").plan?.url, "https://ntfy.example.test");
  assert.ok(!JSON.stringify(plan).includes(PASSWORD));

  const withLonghorn = await call<BundlePlan>(e, "POST", "/bundles/plan", {
    bundleId: "self-hosted",
    inputs: answers,
    include: ["longhorn"],
    apps: { headlamp: { host: "k8s.example.test" } },
  });
  // Longhorn is installed per discovery, so it stays skipped even when ticked.
  assert.match(withLonghorn.steps.find((s) => s.appId === "longhorn")!.reason ?? "", /^Already installed/);
  assert.equal(withLonghorn.steps.find((s) => s.appId === "headlamp")!.plan?.inputs.host, "k8s.example.test");

  const missing = await call<BundlePlan>(e, "POST", "/bundles/plan", {
    bundleId: "self-hosted",
    inputs: { baseDomain: "example.test", adminEmail: "ops@example.test" },
  });
  assert.equal(missing.allowed, false);
  await call(e, "POST", "/bundles/plan", { bundleId: "nope", inputs: {} }, 404);
});

test("bundle run: one step at a time, stops at the first failure", async () => {
  const e = await setup();
  const started = await call<BundleRunView>(e, "POST", "/bundles", { bundleId: "self-hosted", inputs: answers });
  assert.equal(started.id, "br_1");
  assert.equal(started.state, "running");
  assert.equal(states(started)["metrics-server"], "running");
  assert.equal(states(started).authentik, "pending");
  assert.equal(states(started).traefik, "skipped");
  const first = started.steps.find((s) => s.appId === "metrics-server")!;
  assert.equal(first.jobId, "dj_1");
  assert.deepEqual(
    e.mock.audit.map((a) => a.action),
    ["deploy.start-bundle", "deploy.start"]
  );
  assert.ok(!JSON.stringify(e.mock.ctx.db.prepare("SELECT request FROM deploy_bundle_runs").all()).includes(PASSWORD));

  await call(e, "POST", "/bundles", { bundleId: "self-hosted", inputs: answers }, 409);

  await finishJob(e, "dj_1", true);
  let run = await call<BundleRunView>(e, "GET", "/bundles/br_1");
  assert.equal(states(run)["metrics-server"], "succeeded");
  assert.equal(states(run).authentik, "running");
  assert.equal(run.steps.find((s) => s.appId === "authentik")!.url, "https://auth.example.test");

  await finishJob(e, "dj_2", false);
  run = await call<BundleRunView>(e, "GET", "/bundles/br_1");
  assert.equal(run.state, "failed");
  assert.equal(states(run).authentik, "failed");
  assert.equal(states(run).gitea, "pending");
  assert.ok(run.finishedAt);
  assert.deepEqual(e.finished, [{ runId: "br_1", bundleId: "self-hosted", state: "failed" }]);
  assert.equal((await call<BundleRunView[]>(e, "GET", "/bundles")).length, 1);
});

test("bundle run: an optional item that fails is recorded and the rollout carries on", async () => {
  const bundle: CatalogBundle = {
    ...mockBundle,
    items: mockBundle.items.map((item) => (item.appId === "authentik" ? { ...item, required: false } : item)),
  };
  const e = await setup([bundle]);
  await call<BundleRunView>(e, "POST", "/bundles", {
    bundleId: "self-hosted",
    inputs: answers,
    include: ["authentik"],
  });
  await finishJob(e, "dj_1", true);
  await finishJob(e, "dj_2", false);
  let run = await call<BundleRunView>(e, "GET", "/bundles/br_1");
  assert.equal(run.state, "running");
  assert.equal(states(run).authentik, "failed");
  assert.equal(states(run).gitea, "running");
  assert.deepEqual(e.finished, []);

  for (let n = 3; n <= 5; n++) await finishJob(e, `dj_${n}`, true);
  run = await call<BundleRunView>(e, "GET", "/bundles/br_1");
  assert.equal(run.state, "failed", "a failed item still shows on the run");
  assert.deepEqual(
    run.steps.filter((s) => s.state === "succeeded").map((s) => s.appId),
    ["metrics-server", "gitea", "headlamp", "ntfy"]
  );
  assert.deepEqual(e.finished, [{ runId: "br_1", bundleId: "self-hosted", state: "failed" }]);
});

test("bundle run: every step through to success", async () => {
  const e = await setup();
  await call<BundleRunView>(e, "POST", "/bundles", { bundleId: "self-hosted", inputs: answers });
  for (let n = 1; n <= 5; n++) await finishJob(e, `dj_${n}`, true);
  const run = await call<BundleRunView>(e, "GET", "/bundles/br_1");
  assert.equal(run.state, "succeeded", JSON.stringify(run.steps));
  assert.deepEqual(
    run.steps.filter((s) => s.state === "succeeded").map((s) => s.appId),
    ["metrics-server", "authentik", "gitea", "headlamp", "ntfy"]
  );
  const secret = (await e.k8s.get(RESOURCES.secrets, "deploy-gitea-values", NS)) as KubeObject & {
    stringData: Record<string, string>;
  };
  assert.match(secret.stringData["values.yaml"]!, new RegExp(`password: ${PASSWORD}`));
  assert.equal(e.mock.secrets.size, 0, "answers go once the run ends");
});

test("bundle cancel stops the running job and leaves the rest pending", async () => {
  const e = await setup();
  await call<BundleRunView>(e, "POST", "/bundles", { bundleId: "self-hosted", inputs: answers });
  const run = await call<BundleRunView>(e, "POST", "/bundles/br_1/cancel");
  assert.equal(run.state, "cancelled");
  assert.equal(states(run)["metrics-server"], "cancelled");
  assert.equal(states(run).gitea, "pending");
  assert.equal((await call<DeployJobView>(e, "GET", "/jobs/dj_1")).state, "cancelled");
  assert.equal(e.mock.audit.at(-1)?.action, "deploy.cancel-bundle");
  await settle();
  assert.deepEqual(e.finished, [{ runId: "br_1", bundleId: "self-hosted", state: "cancelled" }]);
  await call(e, "POST", "/bundles/br_1/cancel", undefined, 409);
});

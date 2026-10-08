import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { CatalogBundle, CatalogEntry, DiscoveryReport } from "../../../src/contracts/catalog.js";
import type { BundlePlan, BundleRunView, DeployJobView } from "../../../src/contracts/deploy.js";
import type { Events } from "../../../src/contracts/events.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import {
  createMockCatalogService,
  mockBundle,
  mockCatalog,
  mockDiscovery,
} from "../../../src/contracts/mocks/catalog.js";
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

async function setup(bundles?: CatalogBundle[], discovery?: DiscoveryReport): Promise<Env> {
  const k8s = createFakeK8s();
  const mock = createMockContext("deploy", {
    migrations: mod.migrations,
    settings: { "deploy.image": IMAGE, "deploy.namespace": NS },
    services: {
      k8s,
      catalog: createMockCatalogService({
        entries,
        ...(bundles ? { bundles } : {}),
        ...(discovery ? { discovery } : {}),
      }),
    },
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
  assert.equal(step("longhorn").reason, "Every node needs open-iscsi; untick it if yours don't have it.");
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

test("bundle plan: checks the disk the rollout needs against the nodes' free space", async () => {
  const roomy = await setup();
  const plan = await call<BundlePlan>(roomy, "POST", "/bundles/plan", { bundleId: "self-hosted", inputs: answers });
  assert.equal(plan.disk?.status, "ok");
  assert.equal(plan.disk?.nodesRead, 2);
  assert.ok(plan.disk!.volumeBytes > 0 && plan.disk!.imageBytes > 0);
  assert.equal(plan.allowed, true);
  roomy.deployer.stop();
  await roomy.server.close();
  await roomy.mock.close();
  env = undefined;

  const GiB = 1024 ** 3;
  const small = await setup(undefined, {
    ...mockDiscovery,
    nodeDisks: [{ node: "node-1", availableBytes: 3 * GiB, capacityBytes: 30 * GiB }],
  });
  const blocked = await call<BundlePlan>(small, "POST", "/bundles/plan", { bundleId: "self-hosted", inputs: answers });
  assert.equal(blocked.disk?.status, "crit");
  assert.equal(blocked.allowed, false);
  assert.match(blocked.blockedBy ?? "", /the node has 3 GiB free of 30 GiB\. That is .* short/);
  assert.ok(blocked.steps.every((step) => step.skip || step.plan?.allowed));
  const refused = await call<{ error: string }>(
    small,
    "POST",
    "/bundles",
    { bundleId: "self-hosted", inputs: answers },
    400
  );
  assert.match(JSON.stringify(refused), /short: free some space/);
});

test("bundle access: mode items and inputs apply only to their mode; starting saves the access choice", async () => {
  const bundle: CatalogBundle = {
    ...mockBundle,
    inputs: [
      {
        key: "access",
        label: "Access",
        kind: "select",
        required: true,
        options: [
          { value: "cloudflare-tunnel", label: "Cloudflare" },
          { value: "local", label: "Local" },
        ],
      },
      ...mockBundle.inputs,
      {
        key: "tunnelToken",
        label: "Tunnel token",
        kind: "secret",
        required: true,
        when: { input: "access", in: ["cloudflare-tunnel"] },
      },
    ],
    items: [
      { appId: "cloudflared", required: true, when: { input: "access", in: ["cloudflare-tunnel"] } },
      { appId: "headlamp", required: true },
    ],
  };
  const e = await setup([bundle]);

  const local = await call<BundlePlan>(e, "POST", "/bundles/plan", {
    bundleId: bundle.id,
    inputs: { ...answers, access: "local" },
  });
  assert.equal(local.allowed, true);
  assert.deepEqual(
    local.steps.map((s) => [s.appId, s.skip, s.reason]),
    [
      ["cloudflared", true, "Not needed for how you reach the apps"],
      ["headlamp", false, undefined],
    ]
  );
  assert.equal(local.steps[1]!.plan!.url, "http://headlamp.example.test");

  const missing = await call<BundlePlan>(e, "POST", "/bundles/plan", {
    bundleId: bundle.id,
    inputs: { ...answers, access: "cloudflare-tunnel" },
  });
  assert.equal(missing.allowed, false);
  await call(e, "POST", "/bundles", { bundleId: bundle.id, inputs: { ...answers, access: "cloudflare-tunnel" } }, 400);

  const tunnel = { ...answers, access: "cloudflare-tunnel", tunnelToken: "tok-123" };
  const plan = await call<BundlePlan>(e, "POST", "/bundles/plan", { bundleId: bundle.id, inputs: tunnel });
  assert.equal(plan.allowed, true);
  assert.deepEqual(plan.steps[0]!.plan!.inputs, { tunnelToken: "********" });
  assert.equal(plan.steps[1]!.plan!.url, "https://headlamp.example.test");

  await call<BundleRunView>(e, "POST", "/bundles", { bundleId: bundle.id, inputs: tunnel });
  const access = await call<{ mode: string; baseDomain: string }>(e, "GET", "/access");
  assert.equal(access.mode, "cloudflare-tunnel");
  assert.equal(access.baseDomain, "example.test");
  assert.ok(e.mock.audit.some((entry) => entry.action === "deploy.set-access"));
});

test("bundle access: the tunnel token applies only to a pasted-token setup, which an unanswered setup defaults to", async () => {
  const bundle: CatalogBundle = {
    ...mockBundle,
    inputs: [
      {
        key: "access",
        label: "Access",
        kind: "select",
        required: true,
        options: [
          { value: "cloudflare-tunnel", label: "Cloudflare" },
          { value: "local", label: "Local" },
        ],
      },
      ...mockBundle.inputs,
      {
        key: "cloudflareSetup",
        label: "Setup",
        kind: "select",
        required: true,
        default: "token",
        options: [
          { value: "api", label: "API token" },
          { value: "token", label: "Tunnel token" },
        ],
        when: { input: "access", in: ["cloudflare-tunnel"] },
      },
      {
        key: "tunnelToken",
        label: "Tunnel token",
        kind: "secret",
        required: true,
        when: { input: "cloudflareSetup", in: ["token"] },
      },
    ],
    items: [
      { appId: "cloudflared", required: true, when: { input: "cloudflareSetup", in: ["token"] } },
      { appId: "headlamp", required: true },
    ],
  };
  const e = await setup([bundle]);
  const plan = (inputs: Record<string, string>) =>
    call<BundlePlan>(e, "POST", "/bundles/plan", { bundleId: bundle.id, inputs: { ...answers, ...inputs } });

  const api = await plan({ access: "cloudflare-tunnel", cloudflareSetup: "api" });
  assert.equal(api.allowed, true);
  assert.deepEqual(
    api.steps.map((s) => [s.appId, s.skip]),
    [
      ["cloudflared", true],
      ["headlamp", false],
    ]
  );

  const unanswered = await plan({ access: "cloudflare-tunnel" });
  assert.equal(unanswered.allowed, false);

  const stale = await plan({ access: "local", cloudflareSetup: "token" });
  assert.equal(stale.allowed, true);
  assert.equal(stale.steps[0]!.skip, true);
});

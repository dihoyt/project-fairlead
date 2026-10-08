import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { CatalogEntry } from "../../../src/contracts/catalog.js";
import type { DeployActionPlan, DeployJobView, DeployPlan, GateStatus } from "../../../src/contracts/deploy.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { createMockCatalogService, mockCatalog, mockDiscovery } from "../../../src/contracts/mocks/catalog.js";
import { createMockContext, type MockContext } from "../../../src/contracts/mocks/context.js";
import { createMockGate, type MockGate } from "../../../src/contracts/mocks/gate.js";
import { createFakeK8s, type FakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import { GATE_FORWARD_PATH } from "../../../src/contracts/platform.js";
import { annotateSteps, isGateRef, withGate } from "../../../src/modules/deploy/gate.js";
import mod, { registerDeploy } from "../../../src/modules/deploy/index.js";
import type { Deployer } from "../../../src/modules/deploy/runner.js";
import { product } from "../../../src/product.js";
import { listen } from "../../runtime/helpers.js";

const NS = "console";
const IMAGE = "docker.io/alpine/k8s@sha256:1111111111111111111111111111111111111111111111111111111111111111";
const GATE = `${NS}-${product.ownerMarker.externalPrefix}gate@kubernetescrd`;
const CREDENTIALS = `${NS}-${product.ownerMarker.externalPrefix}gate-credentials@kubernetescrd`;
const KEY = "traefik.ingress.kubernetes.io/router.middlewares";

interface Env {
  mock: MockContext;
  k8s: FakeK8s;
  gate: MockGate;
  deployer: Deployer;
  server: { url: string; close(): Promise<void> };
}

let env: Env | undefined;

const entries: CatalogEntry[] = mockCatalog.map((entry) =>
  entry.id === "gitea"
    ? { ...entry, gate: "credentials" }
    : entry.id === "authentik"
      ? { ...entry, gate: "public" }
      : entry.id === "longhorn"
        ? { ...entry, noLogin: true }
        : entry
);

const ingress = (namespace: string, name: string, host: string, middlewares?: string): KubeObject => ({
  apiVersion: "networking.k8s.io/v1",
  kind: "Ingress",
  metadata: { name, namespace, ...(middlewares ? { annotations: { [KEY]: middlewares } } : {}) },
  spec: { ingressClassName: "traefik", rules: [{ host }] },
});

async function setup(
  options: {
    gate?: MockGate;
    access?: { mode: string; baseDomain: string };
    ingresses?: KubeObject[];
    settings?: Record<string, unknown>;
  } = {}
): Promise<Env> {
  const k8s = createFakeK8s({
    objects: [
      {
        ref: RESOURCES.ingresses,
        items: options.ingresses ?? [
          ingress("longhorn-system", "longhorn-ingress", "longhorn.example.test"),
          // Direct exposure's TLS-only Ingress for the same host.
          ingress("longhorn-system", "x-direct-longhorn", "longhorn.example.test"),
          ingress("monitoring", "grafana", "grafana.example.test", `kube-system-redirect@kubernetescrd,${GATE}`),
        ],
      },
    ],
  });
  const gate = options.gate ?? createMockGate();
  const mock = createMockContext("deploy", {
    migrations: mod.migrations,
    settings: { "deploy.image": IMAGE, "deploy.namespace": NS, "deploy.release": "console", ...options.settings },
    services: { k8s, catalog: createMockCatalogService({ entries }), gate },
  });
  const { deployer } = registerDeploy(mock.ctx, { now: () => MOCK_NOW });
  if (options.access) {
    deployer.access.set(options.access as never, "admin", new Date(MOCK_NOW).toISOString());
  }
  const server = await listen(mock.app);
  env = { mock, k8s, gate, deployer, server };
  return env;
}

afterEach(async () => {
  if (!env) return;
  env.deployer.stop();
  await env.server.close();
  await env.mock.close();
  env = undefined;
});

function installed(e: Env, appId: string, namespace: string, seq: number) {
  e.mock.ctx.db
    .prepare(
      `INSERT INTO deploy_jobs (seq, id, app_id, release, namespace, version, mode, state, started_by, created_at,
         job_namespace, job_name)
       VALUES (?, ?, ?, ?, ?, '1.0.0', 'install', 'succeeded', 'admin', ?, ?, ?)`
    )
    .run(seq, `dj_${seq}`, appId, appId, namespace, new Date(MOCK_NOW).toISOString(), NS, `deploy-${appId}-${seq}`);
}

async function call<T>(e: Env, method: "GET" | "POST", path: string, body?: unknown, expect = 200): Promise<T> {
  const res = await fetch(`${e.server.url}/api/deploy${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as T;
  assert.equal(res.status, expect, JSON.stringify(json));
  return json;
}

const valuesOf = async (e: Env, release: string) =>
  (
    (await e.k8s.get(RESOURCES.secrets, `deploy-${release}-values`, NS)) as KubeObject & {
      stringData: Record<string, string>;
    }
  ).stringData;

// --- plans --------------------------------------------------------------------

test("an app is gated by default: its Ingress names the middleware, which points at the console", async () => {
  const e = await setup();
  const plan = await call<DeployPlan>(e, "POST", "/plan", { appId: "headlamp", inputs: {} });
  assert.deepEqual(plan.gate, { state: "gated" });
  assert.match(plan.values, new RegExp(`${KEY}: ${GATE}`));
  assert.match(
    plan.values,
    new RegExp(`address: "?http://console\\.console\\.svc\\.cluster\\.local${GATE_FORWARD_PATH}\\?proto=https"?\n`)
  );
  assert.match(plan.values, /trustForwardHeader: false/);
  assert.match(plan.values, /- Remote-User/);
});

test("an app with its own login for API clients gets the credentials middleware", async () => {
  const e = await setup();
  const plan = await call<DeployPlan>(e, "POST", "/plan", {
    appId: "gitea",
    inputs: { adminPassword: "x".repeat(12) },
  });
  assert.equal(plan.gate?.state, "gated");
  assert.match(plan.values, new RegExp(`${KEY}: ${CREDENTIALS}`));
  assert.match(plan.values, /proto=https&credentials=1/);
});

test("Public, an identity provider, Tailscale, another ingress class and no public URL each leave it ungated", async () => {
  let e = await setup();
  let plan = await call<DeployPlan>(e, "POST", "/plan", { appId: "headlamp", inputs: {}, public: true });
  assert.deepEqual(plan.gate, { state: "public" });
  assert.ok(!plan.values.includes(KEY));
  assert.ok(!plan.commands.some((c) => c.includes("gate-middleware")));

  plan = await call<DeployPlan>(e, "POST", "/plan", { appId: "authentik", inputs: {}, public: false });
  assert.equal(plan.gate?.state, "public");
  assert.ok(!plan.values.includes(KEY));
  await env!.server.close();
  await env!.mock.close();
  env = undefined;

  e = await setup({ access: { mode: "tailscale", baseDomain: "tail1234.ts.net" } });
  plan = await call<DeployPlan>(e, "POST", "/plan", { appId: "headlamp", inputs: {} });
  assert.deepEqual(plan.gate, { state: "tailnet" });
  await env!.server.close();
  await env!.mock.close();
  env = undefined;

  e = await setup({ gate: createMockGate({ ready: false, reason: "No public URL.", signInUrl: "" }) });
  plan = await call<DeployPlan>(e, "POST", "/plan", { appId: "headlamp", inputs: {} });
  assert.deepEqual(plan.gate, { state: "open", reason: "No public URL." });
  assert.ok(plan.warnings.includes("Anyone with its address can open Headlamp: No public URL."), plan.warnings.join());
  await env!.server.close();
  await env!.mock.close();
  env = undefined;

  e = await setup({ settings: { "deploy.ingressClass": "nginx" } });
  plan = await call<DeployPlan>(e, "POST", "/plan", { appId: "headlamp", inputs: {} });
  assert.equal(plan.gate?.state, "open");
  assert.match(plan.gate?.reason ?? "", /ingress class nginx isn't Traefik's/);
});

test("an install saves the Public choice, and later deploys keep it", async () => {
  const e = await setup();
  await call<DeployJobView>(e, "POST", "/jobs", { appId: "headlamp", inputs: {}, mode: "install", public: true });
  assert.ok(!Object.keys(await valuesOf(e, "headlamp")).includes("gate-middleware.yaml"));
  const again = await call<DeployPlan>(e, "POST", "/plan", { appId: "headlamp", inputs: {} });
  assert.equal(again.gate?.state, "public");
});

// --- status, action, health -----------------------------------------------------

test("GET /gate judges every deployed app by its Ingresses", async () => {
  const e = await setup();
  installed(e, "longhorn", "longhorn-system", 1);
  installed(e, "grafana", "monitoring", 2);
  const status = await call<GateStatus>(e, "GET", "/gate");
  assert.equal(status.ready, true);
  assert.equal(status.middleware, GATE);
  assert.deepEqual(
    status.apps.map((a) => [a.appId, a.state]),
    [
      ["grafana", "gated"],
      ["longhorn", "open"],
    ]
  );
  assert.match(
    status.apps[1]!.reason!,
    /longhorn-system\/longhorn-ingress, longhorn-system\/x-direct-longhorn have no gate/
  );
});

test("app-gate puts the gate on every Ingress of the app, and Public takes only ours off", async () => {
  const e = await setup();
  installed(e, "longhorn", "longhorn-system", 1);
  installed(e, "grafana", "monitoring", 2);
  const on = await call<DeployActionPlan>(e, "POST", "/actions/plan", {
    kind: "app-gate",
    appId: "longhorn",
    public: false,
  });
  assert.equal(on.allowed, true, on.blockedBy);
  assert.deepEqual(
    on.steps.flatMap((s) => s.commands),
    [
      "kubectl apply -f /values/gate-middleware.yaml",
      `kubectl annotate ingress longhorn-ingress --namespace longhorn-system ${KEY}=${GATE} --overwrite`,
      `kubectl annotate ingress x-direct-longhorn --namespace longhorn-system ${KEY}=${GATE} --overwrite`,
    ]
  );

  const off = await call<DeployActionPlan>(e, "POST", "/actions/plan", {
    kind: "app-gate",
    appId: "grafana",
    public: true,
  });
  assert.deepEqual(
    off.steps.flatMap((s) => s.commands),
    [`kubectl annotate ingress grafana --namespace monitoring ${KEY}=kube-system-redirect@kubernetescrd --overwrite`]
  );

  await call<DeployJobView>(e, "POST", "/actions/run", { kind: "app-gate", appId: "grafana", public: true });
  const status = await call<GateStatus>(e, "GET", "/gate");
  assert.equal(status.apps.find((a) => a.appId === "grafana")?.public, true);

  const already = await call<DeployActionPlan>(e, "POST", "/actions/plan", {
    kind: "app-gate",
    appId: "authentik",
    public: false,
  });
  assert.equal(already.allowed, false);
});

test("health: an ungated app with no login of its own is critical", async () => {
  const e = await setup();
  installed(e, "longhorn", "longhorn-system", 1);
  installed(e, "grafana", "monitoring", 2);
  const provider = e.mock.ctx.health.list().find((p) => p.id === "deploy.gate")!;
  const results = await provider.collect();
  assert.deepEqual(
    results.map((r) => [r.id, r.status]),
    [
      ["gate.grafana", "ok"],
      ["gate.longhorn", "crit"],
    ]
  );
});

test("the console only sends people back to hosts under the Access domain or on an Ingress", async () => {
  const e = await setup({ access: { mode: "cloudflare-tunnel", baseDomain: "apps.example.test" } });
  assert.equal(await e.gate.allows("wiki.apps.example.test"), true);
  assert.equal(await e.gate.allows(mockDiscovery.ingressHosts[0]!.host), true);
  assert.equal(await e.gate.allows("evil.example.com"), false);
});

test("annotations keep other middlewares and drop only the gate", () => {
  assert.ok(isGateRef(GATE) && isGateRef(CREDENTIALS) && !isGateRef("kube-system-redirect@kubernetescrd"));
  assert.deepEqual(withGate(["a@file", GATE], CREDENTIALS), ["a@file", CREDENTIALS]);
  assert.deepEqual(withGate([GATE], undefined), []);
  const [step] = annotateSteps([{ namespace: "n", name: "i", middlewares: [GATE] }], undefined);
  assert.deepEqual(step!.argv.slice(-2), [`${KEY}-`, "--overwrite"]);
  assert.deepEqual(annotateSteps([{ namespace: "n", name: "Bad Name", middlewares: [] }], GATE), []);
});

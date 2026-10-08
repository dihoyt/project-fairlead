import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { DeployJobView } from "../../../src/contracts/deploy.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { createMockCatalogService } from "../../../src/contracts/mocks/catalog.js";
import { createMockContext, type MockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s, type FakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import type { TemplatePlan, TemplatesView } from "../../../src/contracts/templates.js";
import deployModule, { registerDeploy } from "../../../src/modules/deploy/index.js";
import { firstService } from "../../../src/modules/deploy/manifest.js";
import type { Deployer } from "../../../src/modules/deploy/runner.js";
import { upgradeReport } from "../../../src/modules/deploy/upgrades.js";
import { checkManifests } from "../../../src/modules/templates/guardrail.js";
import mod, { registerTemplates } from "../../../src/modules/templates/index.js";
import { definitionSchema, LIBRARY, parseImage } from "../../../src/modules/templates/library.js";
import {
  entryFor,
  fromDefinition,
  manifests,
  templateLabel,
  toDocuments,
} from "../../../src/modules/templates/render.js";
import { listen } from "../../runtime/helpers.js";

const NS = "console";
const IMAGE = "docker.io/alpine/k8s@sha256:1111111111111111111111111111111111111111111111111111111111111111";

interface Env {
  deploy: MockContext;
  templates: MockContext;
  k8s: FakeK8s;
  deployer: Deployer;
  server: { url: string; close(): Promise<void> };
}

let env: Env | undefined;

async function setup(): Promise<Env> {
  const k8s = createFakeK8s();
  const catalog = createMockCatalogService();
  const deploy = createMockContext("deploy", {
    migrations: deployModule.migrations,
    settings: { "deploy.image": IMAGE, "deploy.namespace": NS, "deploy.release": "console" },
    services: { k8s, catalog },
  });
  const { deployer } = registerDeploy(deploy.ctx, { now: () => MOCK_NOW });
  const templates = createMockContext("templates", {
    migrations: mod.migrations,
    services: { k8s, catalog, deploy: deploy.ctx.services.get("deploy") },
  });
  registerTemplates(templates.ctx, () => MOCK_NOW);
  deploy.ctx.services.provide("templates", templates.ctx.services.get("templates"));
  const server = await listen(templates.app);
  env = { deploy, templates, k8s, deployer, server };
  return env;
}

afterEach(async () => {
  if (!env) return;
  env.deployer.stop();
  await env.server.close();
  await env.templates.close();
  await env.deploy.close();
  env = undefined;
});

async function call<T>(e: Env, method: "GET" | "POST", path: string, body?: unknown, expect = 200): Promise<T> {
  const res = await fetch(`${e.server.url}/api/templates${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as T;
  assert.equal(res.status, expect, JSON.stringify(json));
  return json;
}

// --- library and schema ----------------------------------------------------

test("the starter library is whoami, Uptime Kuma and IT-Tools, each pinned and valid", () => {
  assert.deepEqual(
    LIBRARY.map((t) => t.id),
    ["whoami", "uptime-kuma", "it-tools"]
  );
  for (const t of LIBRARY) assert.ok(definitionSchema.safeParse(t).success, t.id);
});

test("the template schema has no way to ask for the node's disk, network or privileges", () => {
  const base = { ...LIBRARY[0]! };
  for (const extra of [
    { hostPath: "/var/run" },
    { volume: { mountPath: "/data", size: "1Gi", hostPath: { path: "/" } } },
    { privileged: true },
    { hostNetwork: true },
    { securityContext: { privileged: true } },
    { rbac: [{ kind: "ClusterRoleBinding" }] },
  ]) {
    assert.equal(definitionSchema.safeParse({ ...base, ...extra }).success, false, JSON.stringify(extra));
  }
});

test("parseImage needs a tag or digest and spells out Docker Hub names", () => {
  assert.deepEqual(parseImage("nginx:1.27"), {
    name: "docker.io/library/nginx",
    tag: "1.27",
    digest: undefined,
    version: "1.27",
  });
  assert.deepEqual(parseImage("ghcr.io/org/app:2.0.1"), {
    name: "ghcr.io/org/app",
    tag: "2.0.1",
    digest: undefined,
    version: "2.0.1",
  });
  const digest = "a".repeat(64);
  assert.equal(
    (parseImage(`registry.local:5000/team/app@sha256:${digest}`) as { version: string }).version,
    "sha256-aaaaaaaaaaaa"
  );
  assert.match((parseImage("nginx") as { error: string }).error, /tag or digest/);
  assert.ok("error" in parseImage("Nginx:1"));
  assert.ok("error" in parseImage("nginx:1 ; rm"));
});

// --- render and guardrail --------------------------------------------------

test("a library template renders a guarded namespace, a Deployment and a Service the runner can route to", () => {
  const r = fromDefinition(
    LIBRARY.find((t) => t.id === "uptime-kuma")!,
    "status",
    {
      exposed: true,
      storageClass: "longhorn",
    }
  );
  const objects = manifests(r);
  assert.deepEqual(
    objects.map((o) => o.kind),
    ["Namespace", "PersistentVolumeClaim", "Deployment", "Service"]
  );
  const labels = objects[0]!.metadata.labels!;
  assert.equal(labels[templateLabel()], "uptime-kuma");
  assert.equal(labels["pod-security.kubernetes.io/enforce"], "baseline");
  assert.equal(
    objects.every((o) => o.kind === "Namespace" || o.metadata.namespace === "status"),
    true
  );
  const deployment = objects[2] as KubeObject & { spec: { strategy?: { type: string } } };
  assert.equal(deployment.spec.strategy?.type, "Recreate");
  assert.deepEqual(checkManifests(objects, "status"), []);

  const entry = entryFor(r, objects);
  assert.equal(entry.install.kind, "manifest");
  assert.equal(entry.namespace, "status");
  assert.deepEqual(firstService(toDocuments(objects)), { name: "status", namespace: "status", port: 3001 });
  assert.match(toDocuments(objects), /storageClassName: longhorn/);
});

const pod = (spec: Record<string, unknown>): KubeObject => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "bad", namespace: "app" },
  spec: { template: { spec } },
});
const rules = (objects: KubeObject[]) => checkManifests(objects, "app").map((v) => v.rule);

test("the guardrail refuses privileged, host access, extra capabilities and cluster-wide RBAC", () => {
  assert.deepEqual(rules([pod({ volumes: [{ name: "x", hostPath: { path: "/" } }], containers: [] })]), ["host-path"]);
  assert.deepEqual(rules([pod({ hostNetwork: true, hostPID: true, hostIPC: true, containers: [] })]), [
    "host-network",
    "host-pid",
    "host-ipc",
  ]);
  assert.deepEqual(
    rules([
      pod({
        containers: [
          {
            name: "c",
            ports: [{ containerPort: 80, hostPort: 80 }],
            securityContext: {
              privileged: true,
              allowPrivilegeEscalation: true,
              capabilities: { add: ["NET_BIND_SERVICE", "SYS_ADMIN"] },
            },
          },
        ],
      }),
    ]),
    ["privileged", "privilege-escalation", "capabilities", "host-port"]
  );
  assert.deepEqual(
    rules([
      { kind: "ClusterRoleBinding", metadata: { name: "x" } },
      {
        kind: "RoleBinding",
        metadata: { name: "x", namespace: "app" },
        roleRef: { kind: "ClusterRole", name: "admin" },
      },
      { kind: "Role", metadata: { name: "x", namespace: "app" }, rules: [{ verbs: ["*"], resources: ["pods"] }] },
      { kind: "DaemonSet", metadata: { name: "x", namespace: "app" } },
      { kind: "Service", metadata: { name: "x", namespace: "kube-system" } },
    ]),
    ["cluster-rbac", "cluster-rbac", "cluster-rbac", "kind", "kind"]
  );
});

// --- routes ----------------------------------------------------------------

test("GET lists the library with Custom app last and no instances yet", async () => {
  const e = await setup();
  const view = await call<TemplatesView>(e, "GET", "");
  assert.deepEqual(
    view.templates.map((t) => t.id),
    ["whoami", "uptime-kuma", "it-tools", "custom"]
  );
  assert.deepEqual(view.instances, []);
});

test("plan: whoami gets a host under the base domain, its manifests and the runner's Ingress", async () => {
  const e = await setup();
  const plan = await call<TemplatePlan>(e, "POST", "/plan", { templateId: "whoami" });
  assert.equal(plan.allowed, true, plan.blockedBy);
  assert.equal(plan.name, "whoami");
  assert.match(plan.manifests, /image: docker.io\/traefik\/whoami:v1.11.0/);
  assert.equal(plan.deploy?.url, "https://whoami.example.test");
  assert.deepEqual(plan.deploy?.commands, [
    "kubectl apply -f /values/manifest.yaml",
    "kubectl apply -f /values/ingress.yaml",
    "kubectl rollout status deployment/whoami --namespace whoami --timeout=5m",
  ]);
  assert.match(plan.deploy!.values, /kind: Ingress/);

  const internal = await call<TemplatePlan>(e, "POST", "/plan", { templateId: "it-tools", host: "" });
  assert.equal(internal.allowed, true, internal.blockedBy);
  assert.equal(internal.deploy?.url, undefined);
  assert.deepEqual(internal.deploy?.commands, [
    "kubectl apply -f /values/manifest.yaml",
    "kubectl rollout status deployment/it-tools --namespace it-tools --timeout=5m",
  ]);
});

test("plan: field errors for a custom app, a catalog name and a bad host; unknown template 404", async () => {
  const e = await setup();
  const noTag = await call<TemplatePlan>(e, "POST", "/plan", {
    templateId: "custom",
    name: "my-api",
    custom: { image: "ghcr.io/example/my-api", port: 8080, env: [{ name: "1BAD", value: "x" }] },
  });
  assert.equal(noTag.allowed, false);
  assert.match(noTag.fieldErrors["custom.image"]!, /tag or digest/);
  assert.ok(noTag.fieldErrors["custom.env.0.name"]);
  assert.equal(noTag.manifests, "");

  const clash = await call<TemplatePlan>(e, "POST", "/plan", { templateId: "whoami", name: "grafana" });
  assert.match(clash.fieldErrors.name!, /catalog/);

  const host = await call<TemplatePlan>(e, "POST", "/plan", { templateId: "whoami", host: "not a host" });
  assert.equal(host.allowed, false);
  assert.ok(host.fieldErrors.host);

  await call(e, "POST", "/plan", { templateId: "nope" }, 404);
  await call(e, "POST", "/plan", { templateId: "whoami", custom: { image: "a:1", port: 1, env: [] } });
});

test("a custom app renders its image, port, env and volume and deploys through the runner", async () => {
  const e = await setup();
  const body = {
    templateId: "custom",
    name: "my-api",
    host: "api.example.test",
    storageClass: "local-path",
    custom: {
      image: "ghcr.io/example/my-api:1.4.2",
      port: 8080,
      env: [
        { name: "LOG_LEVEL", value: "info" },
        { name: "ENABLED", value: "true" },
      ],
      volume: { size: "2Gi", mountPath: "/data" },
    },
  };
  const plan = await call<TemplatePlan>(e, "POST", "/plan", body);
  assert.equal(plan.allowed, true, plan.blockedBy);
  assert.match(plan.manifests, /image: ghcr.io\/example\/my-api:1.4.2/);
  assert.match(plan.manifests, /value: "true"/);
  assert.match(plan.manifests, /mountPath: \/data/);
  assert.match(plan.manifests, /storage: "2Gi"/);
  assert.equal(plan.deploy?.url, "https://api.example.test");

  const job = await call<DeployJobView>(e, "POST", "/jobs", { ...body, mode: "install" });
  assert.equal(job.appId, "my-api");
  assert.equal(job.namespace, "my-api");
  assert.equal(job.version, "1.4.2");
  const secret = (await e.k8s.get(RESOURCES.secrets, "deploy-my-api-values", NS)) as KubeObject & {
    stringData: Record<string, string>;
  };
  assert.equal(secret.stringData["manifest.yaml"], plan.manifests);
  assert.match(secret.stringData["ingress.yaml"]!, /host: api.example.test/);
  assert.equal(e.templates.audit.at(-1)?.action, "templates.deploy");

  const view = await call<TemplatesView>(e, "GET", "");
  assert.equal(view.instances.length, 1);
  assert.equal(view.instances[0]!.host, "api.example.test");
  assert.equal(view.instances[0]!.custom?.image, "ghcr.io/example/my-api:1.4.2");

  // The name is taken by another template now; the same app again is a 409 only while its job runs.
  await call(e, "POST", "/jobs", { templateId: "whoami", name: "my-api", mode: "install" }, 409);
  await call(e, "POST", "/jobs", { ...body, mode: "install" }, 409);
});

test("a dry run saves nothing; a blocked plan is a 400", async () => {
  const e = await setup();
  await call<DeployJobView>(e, "POST", "/jobs", { templateId: "whoami", mode: "dry-run" });
  assert.deepEqual((await call<TemplatesView>(e, "GET", "")).instances, []);
  await call(
    e,
    "POST",
    "/jobs",
    { templateId: "custom", name: "x", custom: { image: "x", port: 1, env: [] }, mode: "install" },
    400
  );
});

test("upgrades cover a template instance on the runner's record and apply the new pin's manifest", async () => {
  const e = await setup();
  await call<DeployJobView>(e, "POST", "/jobs", { templateId: "whoami", mode: "install" });
  const [entry] = e.templates.ctx.services.get("templates").entries();
  assert.equal(entry?.id, "whoami");
  const report = upgradeReport({
    entries: [
      { ...entry!, install: { ...(entry!.install as { kind: "manifest"; bundled: string }), version: "v1.12.0" } },
    ],
    discovery: { checkedAt: "", apps: [], ingressHosts: [], basics: [], suggested: {} },
    enabled: true,
    releases: [{ appId: "whoami", release: "whoami", namespace: "whoami", jobId: "dj_1", state: "succeeded" }],
    versions: new Map([["whoami", "v1.11.0"]]),
    busy: new Set(),
    checkedAt: "",
  });
  assert.equal(report.apps[0]?.state, "available");
  assert.equal(report.apps[0]?.targetVersion, "v1.12.0");
  assert.deepEqual(report.apps[0]?.commands, [
    "kubectl apply -f /values/manifest.yaml",
    "kubectl rollout status deployment/whoami --namespace whoami --timeout=5m",
  ]);
});

test("a finished upgrade moves the instance to the library's pin and records the job", async () => {
  const mock = createMockContext("templates", { migrations: mod.migrations });
  const templates = registerTemplates(mock.ctx);
  templates.store.save(
    { name: "whoami", templateId: "whoami", version: "v1.10.0", host: "", lastJobId: "dj_1", createdBy: "admin" },
    "2026-01-01T00:00:00.000Z"
  );
  assert.equal(templates.instances([])[0]?.newerVersion, "v1.11.0");
  templates.finished({ jobId: "dj_9", appId: "whoami", mode: "upgrade", state: "succeeded" });
  const record = templates.store.get("whoami")!;
  assert.equal(record.version, "v1.11.0");
  assert.equal(record.lastJobId, "dj_9");
  assert.equal(templates.instances([])[0]?.newerVersion, undefined);
  await mock.close();
});

test("a succeeded remove-app job forgets the instance; a failed one keeps it with the job", async () => {
  const mock = createMockContext("templates", { migrations: mod.migrations });
  const templates = registerTemplates(mock.ctx);
  templates.store.save(
    { name: "whoami", templateId: "whoami", version: "v1.11.0", host: "", lastJobId: "dj_1", createdBy: "admin" },
    "2026-01-01T00:00:00.000Z"
  );
  mock.ctx.bus.emit("deploy.finished", {
    jobId: "dj_2",
    appId: "whoami",
    mode: "action",
    action: "remove-app",
    state: "failed",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(templates.store.get("whoami")?.lastJobId, "dj_2");
  mock.ctx.bus.emit("deploy.finished", {
    jobId: "dj_3",
    appId: "whoami",
    mode: "action",
    action: "remove-app",
    state: "succeeded",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(templates.store.get("whoami"), undefined);
  assert.deepEqual(templates.entries(), []);
  await mock.close();
});

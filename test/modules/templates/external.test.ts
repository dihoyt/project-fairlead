import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { CheckRequest } from "../../../src/contracts/checks.js";
import type { DeployJobView, PortsView } from "../../../src/contracts/deploy.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { createMockCatalogService } from "../../../src/contracts/mocks/catalog.js";
import { createMockContext, type MockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s, type FakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { mockPortsView } from "../../../src/contracts/mocks/templates.js";
import { MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import type { ExternalServiceSpec, TemplatePlan, TemplatesView } from "../../../src/contracts/templates.js";
import deployModule, { registerDeploy } from "../../../src/modules/deploy/index.js";
import { checksFor } from "../../../src/modules/deploy/actions/remove.js";
import { firstService } from "../../../src/modules/deploy/manifest.js";
import type { Deployer } from "../../../src/modules/deploy/runner.js";
import { checkExternal, externalCheck, externalWarnings } from "../../../src/modules/templates/external.js";
import mod, { registerTemplates } from "../../../src/modules/templates/index.js";
import { listen } from "../../runtime/helpers.js";

const NS = "console";
const IMAGE = "docker.io/alpine/k8s@sha256:1111111111111111111111111111111111111111111111111111111111111111";

interface Env {
  deploy: MockContext;
  templates: MockContext;
  k8s: FakeK8s;
  deployer: Deployer;
  checks: CheckRequest[];
  server: { url: string; close(): Promise<void> };
}

let env: Env | undefined;

async function setup(ports: Partial<PortsView> = {}): Promise<Env> {
  const k8s = createFakeK8s();
  const catalog = createMockCatalogService();
  const deploy = createMockContext("deploy", {
    migrations: deployModule.migrations,
    settings: { "deploy.image": IMAGE, "deploy.namespace": NS, "deploy.release": "console" },
    services: { k8s, catalog },
  });
  const { deployer } = registerDeploy(deploy.ctx, { now: () => MOCK_NOW });
  const checks: CheckRequest[] = [];
  const templates = createMockContext("templates", {
    migrations: mod.migrations,
    services: { k8s, catalog, deploy: deploy.ctx.services.get("deploy") },
    calls: {
      "GET /api/deploy/ports": () => ({ ...structuredClone(mockPortsView), wanted: [], open: [], ...ports }),
      "GET /api/checks": () => [],
      "POST /api/checks": ({ body }) => {
        checks.push(body!);
        return { id: "c1", tlsWarnDays: 14, enabled: true, intervalMs: 60_000, timeoutMs: 5_000, ...body! };
      },
    },
  });
  registerTemplates(templates.ctx, () => MOCK_NOW);
  deploy.ctx.services.provide("templates", templates.ctx.services.get("templates"));
  const server = await listen(templates.app);
  env = { deploy, templates, k8s, deployer, checks, server };
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

const game: ExternalServiceSpec = { address: "10.0.0.50", port: 2456, protocol: "udp", publicPort: 25565 };

test("the spec needs an address on the network, valid ports and a known protocol", () => {
  const errors: Record<string, string> = {};
  checkExternal({ address: "nas.local", port: 0, protocol: "ftp" as "tcp", publicPort: 5 }, errors);
  assert.match(errors["external.address"]!, /IP address/);
  assert.ok(errors["external.port"]);
  assert.ok(errors["external.protocol"]);
  for (const address of ["127.0.0.1", "169.254.169.254", "::1", "fe80::1"]) {
    const e: Record<string, string> = {};
    checkExternal({ address, port: 80, protocol: "http" }, e);
    assert.match(e["external.address"]!, /not this machine/, address);
  }
  const http: Record<string, string> = {};
  checkExternal({ address: "10.0.0.5", port: 80, protocol: "http", publicPort: 8081, insecureSkipVerify: true }, http);
  assert.match(http["external.publicPort"]!, /only for tcp and udp/);
  assert.match(http["external.insecureSkipVerify"]!, /only for https/);
});

test("mismatched ports warn that the service may only work when reached directly", () => {
  const [mismatch, tunnel] = externalWarnings(game, undefined);
  assert.match(mismatch!, /connect on port 25565 while the service listens on 2456/);
  assert.match(mismatch!, /reached directly at 10\.0\.0\.50:2456/);
  assert.match(tunnel!, /can't go through a Cloudflare tunnel/);
  assert.equal(externalWarnings({ ...game, publicPort: undefined }, undefined).length, 1);
  assert.match(
    externalWarnings({ address: "10.0.0.20", port: 5001, protocol: "https" }, "nas.example.test")[0]!,
    /reached directly at 10\.0\.0\.20:5001/
  );
  assert.deepEqual(externalWarnings({ address: "10.0.0.20", port: 443, protocol: "https" }, "nas.example.test"), []);
});

test("the health check watches the target itself; UDP gets none", () => {
  assert.deepEqual(externalCheck("mc", { address: "10.0.0.50", port: 25565, protocol: "tcp" }), {
    label: "mc (external)",
    kind: "tcp",
    target: "10.0.0.50:25565",
  });
  assert.deepEqual(
    externalCheck("nas", { address: "10.0.0.20", port: 5001, protocol: "https", insecureSkipVerify: true }),
    {
      label: "nas (external)",
      kind: "http",
      target: "https://10.0.0.20:5001/",
      insecureSkipVerify: true,
    }
  );
  assert.equal(externalCheck("valheim", game), undefined);
});

test("plan: a UDP game server renders a Service, an EndpointSlice and an IngressRouteUDP on its entrypoint", async () => {
  const e = await setup();
  const plan = await call<TemplatePlan>(e, "POST", "/plan", {
    templateId: "external",
    name: "valheim",
    host: "ignored.example.test",
    external: game,
  });
  assert.equal(plan.allowed, true, plan.blockedBy);
  assert.deepEqual(plan.violations, []);
  assert.match(plan.manifests, /kind: EndpointSlice/);
  assert.match(plan.manifests, /- "10\.0\.0\.50"|- 10\.0\.0\.50/);
  assert.match(plan.manifests, /kind: IngressRouteUDP/);
  assert.match(plan.manifests, /- udp-25565/);
  assert.doesNotMatch(plan.manifests, /kind: Deployment/);
  assert.equal(plan.deploy?.url, undefined);
  assert.deepEqual(plan.deploy?.commands, ["kubectl apply -f /values/manifest.yaml"]);
  assert.deepEqual(plan.entrypoint, { name: "udp-25565", port: 25565, protocol: "udp", open: false });
  assert.ok(plan.deploy?.warnings.some((w) => /reached directly at 10\.0\.0\.50:2456/.test(w)));
});

test("plan: the public port must be in the forwarded range and not taken", async () => {
  const outside = await setup();
  const plan = await call<TemplatePlan>(outside, "POST", "/plan", {
    templateId: "external",
    name: "mc",
    external: { address: "10.0.0.50", port: 25565, protocol: "tcp", publicPort: 30000 },
  });
  assert.equal(plan.allowed, false);
  assert.match(plan.fieldErrors["external.publicPort"]!, /outside the forwarded ports \(25565-25575\)/);
  await outside.server.close();
  await outside.templates.close();
  await outside.deploy.close();
  outside.deployer.stop();
  env = undefined;

  const taken = await setup({ wanted: [{ appId: "other", port: 25565, protocol: "tcp" }] });
  const clash = await call<TemplatePlan>(taken, "POST", "/plan", {
    templateId: "external",
    name: "mc",
    external: { address: "10.0.0.50", port: 25565, protocol: "tcp" },
  });
  assert.match(clash.fieldErrors["external.port"]!, /already used by other/);
  // Another protocol on the same port is a different entrypoint.
  const udp = await call<TemplatePlan>(taken, "POST", "/plan", {
    templateId: "external",
    name: "mc",
    external: { address: "10.0.0.50", port: 25565, protocol: "udp" },
  });
  assert.equal(udp.allowed, true, udp.blockedBy);
});

test("plan: without a forwarded range TCP and UDP are refused with where to set it", async () => {
  const e = await setup({ range: "", ranges: [] });
  const plan = await call<TemplatePlan>(e, "POST", "/plan", {
    templateId: "external",
    name: "mc",
    external: { address: "10.0.0.50", port: 25565, protocol: "tcp" },
  });
  assert.match(plan.fieldErrors["external.port"]!, /Forwarded ports/);
});

test("an https NAS gets the runner's Ingress, a self-signed transport and a check on the target", async () => {
  const e = await setup();
  const body = {
    templateId: "external",
    name: "nas",
    external: { address: "10.0.0.20", port: 5001, protocol: "https", insecureSkipVerify: true },
  };
  const plan = await call<TemplatePlan>(e, "POST", "/plan", body);
  assert.equal(plan.allowed, true, plan.blockedBy);
  assert.equal(plan.deploy?.url, "https://nas.example.test");
  assert.match(plan.manifests, /service\.serversscheme: https/);
  assert.match(plan.manifests, /kind: ServersTransport/);
  assert.equal(plan.entrypoint, undefined);
  assert.deepEqual(firstService(plan.manifests), { name: "nas", namespace: "nas", port: 5001 });

  const job = await call<DeployJobView>(e, "POST", "/jobs", { ...body, mode: "install" });
  assert.equal(job.appId, "nas");
  const secret = (await e.k8s.get(RESOURCES.secrets, "deploy-nas-values", NS)) as KubeObject & {
    stringData: Record<string, string>;
  };
  assert.match(secret.stringData["ingress.yaml"]!, /name: nas[\s\S]*number: 5001/);
  assert.deepEqual(e.checks, [
    { label: "nas (external)", kind: "http", target: "https://10.0.0.20:5001/", insecureSkipVerify: true },
  ]);

  const view = await call<TemplatesView>(e, "GET", "");
  const nas = view.instances.find((i) => i.name === "nas")!;
  assert.equal(nas.external?.address, "10.0.0.20");
  assert.deepEqual(
    checksFor(nas, [
      { id: "c1", label: "renamed", kind: "http", target: "https://10.0.0.20:5001/" } as never,
      { id: "c2", label: "other", kind: "tcp", target: "10.0.0.21:5001" } as never,
    ]).map((c) => c.id),
    ["c1"]
  );
});

test("forwardedPorts lists the public ports of saved TCP and UDP services", async () => {
  const e = await setup();
  await call(e, "POST", "/jobs", { templateId: "external", name: "valheim", external: game, mode: "install" });
  await call(e, "POST", "/jobs", {
    templateId: "external",
    name: "web",
    external: { address: "10.0.0.7", port: 8080, protocol: "http" },
    mode: "install",
  });
  assert.deepEqual(e.templates.ctx.services.get("templates").forwardedPorts(), [
    { appId: "valheim", port: 25565, protocol: "udp" },
  ]);
});

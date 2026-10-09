import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { DeployActionPlan, PortsView, WantedPort } from "../../../src/contracts/deploy.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { createMockCatalogService } from "../../../src/contracts/mocks/catalog.js";
import { createMockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s, type FakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { createMockTemplatesService } from "../../../src/contracts/mocks/templates.js";
import { MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import deployModule, { registerDeploy } from "../../../src/modules/deploy/index.js";
import { K3S_SCRIPT, openPorts, parseRanges, portsView } from "../../../src/modules/deploy/ports.js";
import { listen } from "../../runtime/helpers.js";

const IMAGE = "docker.io/alpine/k8s@sha256:1111111111111111111111111111111111111111111111111111111111111111";

const k3sTraefik = (ports: Array<{ name: string; port: number; protocol?: string }> = []): KubeObject =>
  ({
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: "traefik", namespace: "kube-system" },
    spec: {
      type: "LoadBalancer",
      ports: [{ name: "web", port: 80, protocol: "TCP" }, { name: "websecure", port: 443, protocol: "TCP" }, ...ports],
    },
    status: { loadBalancer: { ingress: [{ ip: "10.0.0.10" }] } },
  }) as KubeObject;

test("parseRanges merges ranges and refuses low, reserved, backwards and too many ports", () => {
  assert.deepEqual(parseRanges(""), { ranges: [] });
  assert.deepEqual(parseRanges("27015, 25565-25570,25571-25575").ranges, [
    { from: 25565, to: 25575 },
    { from: 27015, to: 27015 },
  ]);
  assert.match(parseRanges("80").error!, /from 1024/);
  assert.match(parseRanges("7990-8010").error!, /8000 is one of Traefik's own ports/);
  assert.match(parseRanges("30000-29000").error!, /backwards/);
  assert.match(parseRanges("20000-20200").error!, /at most 100/);
  assert.match(parseRanges("abc").error!, /not a port/);
});

test("openPorts reads only entrypoints named after this product's convention, by protocol", () => {
  assert.deepEqual(
    openPorts(
      k3sTraefik([
        { name: "udp-25565", port: 25565, protocol: "UDP" },
        { name: "tcp-25565", port: 25565, protocol: "TCP" },
        { name: "udp-1", port: 1, protocol: "TCP" },
        { name: "minecraft", port: 25566, protocol: "TCP" },
      ]) as never
    ),
    [
      { port: 25565, protocol: "tcp" },
      { port: 25565, protocol: "udp" },
    ]
  );
});

const fake = (service: KubeObject) => createFakeK8s({ objects: [{ ref: RESOURCES.services, items: [service] }] });

async function view(k8s: FakeK8s, wanted: WantedPort[], range = "25565-25575"): Promise<PortsView> {
  return portsView({ setting: { get: () => range }, k8s, releases: [], wanted });
}

test("portsView finds k3s's Traefik, its address, and whether open matches wanted", async () => {
  const k8s = fake(k3sTraefik([{ name: "tcp-25570", port: 25570, protocol: "TCP" }]));
  const v = await view(k8s, [
    { appId: "valheim", port: 25565, protocol: "udp" },
    { appId: "mc", port: 30000, protocol: "tcp" },
  ]);
  assert.deepEqual(v.traefik, { kind: "k3s", namespace: "kube-system", service: "traefik" });
  assert.equal(v.address, "10.0.0.10");
  assert.deepEqual(v.open, [{ port: 25570, protocol: "tcp" }]);
  assert.equal(v.inSync, false);
  assert.deepEqual(
    v.outOfRange.map((w) => w.appId),
    ["mc"]
  );

  const none = await view(createFakeK8s(), []);
  assert.equal(none.traefik, undefined);
  assert.match(none.traefikNote!, /No Traefik/);
  assert.equal(none.inSync, true);
});

async function plan(k8s: FakeK8s, wanted: WantedPort[], range: string): Promise<DeployActionPlan> {
  const catalog = createMockCatalogService();
  const ctx = createMockContext("deploy", {
    migrations: deployModule.migrations,
    settings: { "deploy.image": IMAGE, "deploy.namespace": "console", "deploy.forwardedPorts": range },
    services: { k8s, catalog, templates: createMockTemplatesService([], wanted) },
    calls: {
      "GET /api/deploy/ports": () => portsView({ setting: { get: () => range }, k8s, releases: [], wanted }),
    },
  });
  const { deployer } = registerDeploy(ctx.ctx, { now: () => MOCK_NOW });
  const server = await listen(ctx.app);
  try {
    const res = await fetch(`${server.url}/api/deploy/actions/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "traefik-ports" }),
    });
    const body = (await res.json()) as DeployActionPlan;
    assert.equal(res.status, 200, JSON.stringify(body));
    return body;
  } finally {
    deployer.stop();
    await server.close();
    await ctx.close();
  }
}

test("the traefik-ports action opens wanted ports, closes unused ones, and refuses out-of-range ones", async () => {
  const k8s = fake(k3sTraefik([{ name: "tcp-25570", port: 25570, protocol: "TCP" }]));
  const p = await plan(k8s, [{ appId: "valheim", port: 25565, protocol: "udp" }], "25565-25575");
  assert.equal(p.allowed, true, p.blockedBy);
  assert.equal(p.title, "Update forwarded ports on Traefik");
  assert.deepEqual(
    p.steps.map((s) => s.label),
    ["Open UDP 25565", "Close TCP 25570, which nothing uses any more"]
  );
  assert.deepEqual(p.changes[0], { kind: "HelmChartConfig", name: "traefik", namespace: "kube-system" });

  const out = await plan(fake(k3sTraefik()), [{ appId: "mc", port: 30000, protocol: "tcp" }], "25565-25575");
  assert.equal(out.allowed, false);
  assert.match(out.blockedBy!, /mc asks for TCP 30000, outside the forwarded ports/);

  const synced = await plan(
    fake(k3sTraefik([{ name: "udp-25565", port: 25565, protocol: "UDP" }])),
    [{ appId: "valheim", port: 25565, protocol: "udp" }],
    "25565-25575"
  );
  assert.equal(synced.allowed, false);
  assert.match(synced.blockedBy!, /already serves exactly/);
});

// The merge the k3s script does, run with the real jq and yq when present.
test("the k3s script's merge keeps other values and ports and only touches ours", (t) => {
  let have = true;
  try {
    execFileSync("sh", ["-c", "command -v jq && command -v yq"], { stdio: "ignore" });
  } catch {
    have = false;
  }
  if (!have) {
    t.skip("jq or yq not installed");
    return;
  }
  const filter = /jq --slurpfile p "\$P" '([\s\S]*?)' \/tmp\/current\.json/.exec(K3S_SCRIPT)![1]!;
  const current = {
    logs: { general: { level: "INFO" } },
    ports: { web: { forwardedHeaders: { insecure: true } }, "tcp-25570": {} },
  };
  const p = { add: { "udp-25565": { port: 25565 } }, remove: ["tcp-25570"] };
  const out = execFileSync("jq", ["--argjson", "p0", JSON.stringify(p), filter.replaceAll("$p[0]", "$p0")], {
    input: JSON.stringify(current),
  }).toString();
  assert.deepEqual(JSON.parse(out), {
    logs: { general: { level: "INFO" } },
    ports: { web: { forwardedHeaders: { insecure: true } }, "udp-25565": { port: 25565 } },
  });
});

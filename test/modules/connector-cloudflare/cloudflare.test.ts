import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type {
  CloudflareDiscovery,
  CloudflareHostView,
  CloudflareView,
  ConnectorInstance,
} from "../../../src/contracts/connectors.js";
import type { AccessView, DeployJobView } from "../../../src/contracts/deploy.js";
import { createMockContext } from "../../../src/contracts/mocks/context.js";
import { createMockConnectorRegistry } from "../../../src/contracts/mocks/connectors/registry.js";
import { createMockDeployService } from "../../../src/contracts/mocks/deploy.js";
import { createMockCatalogService, mockAccess, mockDiscovery } from "../../../src/contracts/mocks/catalog.js";
import { createFakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import cloudflare from "../../../src/modules/connector-cloudflare/index.js";
import { product } from "../../../src/product.js";
import {
  MOCK_ACCOUNT,
  MOCK_TOKEN,
  MOCK_ZONE,
  mockCloudflareState,
  startMockCloudflare,
  type CloudflareState,
} from "../../support/mocks/cloudflare/server.js";

const INGRESS = "http://traefik.kube-system.svc.cluster.local:80";
const TAG = product.ownerMarker.externalTag;

const access = (over: Partial<AccessView> = {}): AccessView => ({
  ...mockAccess,
  baseDomain: MOCK_ZONE,
  ingressService: INGRESS,
  hosts: [
    { appId: "grafana", host: `grafana.${MOCK_ZONE}`, url: `https://grafana.${MOCK_ZONE}` },
    { appId: "gitea", host: `gitea.${MOCK_ZONE}`, url: `https://gitea.${MOCK_ZONE}` },
  ],
  ...over,
});

const instance = (config: Record<string, string> = {}): ConnectorInstance => ({
  id: "cn_1",
  kind: "cloudflare",
  name: "Cloudflare",
  config: { accountId: MOCK_ACCOUNT, zone: MOCK_ZONE, tunnelId: "", publicAddress: "", accessEmails: "", ...config },
  secrets: { apiToken: MOCK_TOKEN },
});

async function setup(
  options: {
    state?: CloudflareState;
    access?: AccessView;
    config?: Record<string, string>;
    settings?: Record<string, unknown>;
    connected?: boolean;
    issuer?: string | null;
  } = {}
) {
  const cf = await startMockCloudflare(options.state ?? mockCloudflareState());
  const registry = createMockConnectorRegistry(options.connected === false ? [] : [instance(options.config)]);
  let current = options.access ?? access();
  const deploy = createMockDeployService();
  deploy.access = async () => structuredClone(current);
  const k8s = createFakeK8s({ objects: [{ ref: RESOURCES.ingresses, items: [giteaIngress] }] });
  const issuer = options.issuer === undefined ? "letsencrypt-prod" : options.issuer;
  const catalog = createMockCatalogService({
    discovery: {
      ...mockDiscovery,
      suggested: { ...mockDiscovery.suggested, ...(issuer ? { clusterIssuer: issuer } : { clusterIssuer: undefined }) },
    },
  });
  const m = createMockContext("connector-cloudflare", {
    migrations: cloudflare.migrations ?? [],
    services: { connectors: registry, deploy, k8s, catalog },
    settings: { "connector-cloudflare.apiBase": cf.url, ...options.settings },
    calls: {
      "POST /api/deploy/jobs": (input) =>
        ({ id: "dj_9", appId: input.body!.appId, state: "pending" }) as unknown as DeployJobView,
    },
  });
  await cloudflare.register(m.ctx);
  const server: Server = await new Promise((resolve) => {
    const s = m.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/connector-cloudflare`;
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T & { error?: string } };
  };
  const kind = registry.kinds()[0]!;
  return {
    m,
    cf,
    deploy,
    k8s,
    registry,
    kind,
    call,
    setAccess(next: AccessView) {
      current = next;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await m.close();
      await cf.close();
    },
  };
}

const giteaIngress: KubeObject = {
  metadata: { name: "gitea", namespace: "gitea" },
  spec: {
    ingressClassName: "traefik",
    rules: [
      {
        host: `gitea.${MOCK_ZONE}`,
        http: { paths: [{ path: "/", backend: { service: { name: "gitea-http", port: { number: 3000 } } } }] },
      },
    ],
  },
};

const hostOf = (view: CloudflareView, host: string) => view.hosts.find((h) => h.host === host)!;

test("adds the cloudflare kind with its fields", async () => {
  const s = await setup();
  try {
    assert.equal(s.kind.kind, "cloudflare");
    assert.equal(s.kind.single, true);
    assert.deepEqual(
      s.kind.fields.filter((f) => f.type === "secret").map((f) => f.key),
      ["apiToken"]
    );
  } finally {
    await s.close();
  }
});

test("verify passes a good token and says why a bad one fails", async () => {
  const s = await setup();
  try {
    const signal = new AbortController().signal;
    const good = await s.kind.verify({ apiToken: MOCK_TOKEN, accountId: MOCK_ACCOUNT, zone: MOCK_ZONE }, signal);
    assert.deepEqual(
      good.map((c) => [c.id, c.status]),
      [
        ["token", "ok"],
        ["account", "ok"],
        ["zone", "ok"],
        ["tunnel", "ok"],
      ]
    );
    const bad = await s.kind.verify({ apiToken: "nope", accountId: MOCK_ACCOUNT, zone: MOCK_ZONE }, signal);
    assert.equal(bad[0]!.status, "crit");
    assert.match(bad[0]!.detail, /Invalid request headers/);
    const zone = await s.kind.verify({ apiToken: MOCK_TOKEN, accountId: MOCK_ACCOUNT, zone: "other.test" }, signal);
    assert.equal(zone.find((c) => c.id === "zone")!.status, "crit");
  } finally {
    await s.close();
  }
});

test("verify reports a token without the tunnel scope", async () => {
  const state = mockCloudflareState();
  state.tokens.set(MOCK_TOKEN, { status: "active", scopes: ["dns"] });
  const s = await setup({ state });
  try {
    const checks = await s.kind.verify(
      { apiToken: MOCK_TOKEN, accountId: MOCK_ACCOUNT, zone: MOCK_ZONE },
      new AbortController().signal
    );
    assert.equal(checks.find((c) => c.id === "tunnel")!.status, "crit");
  } finally {
    await s.close();
  }
});

test("an account-owned token verifies under its account", async () => {
  const state = mockCloudflareState();
  state.tokens.set(MOCK_TOKEN, { status: "active", account: MOCK_ACCOUNT });
  const s = await setup({ state });
  try {
    const checks = await s.kind.verify(
      { apiToken: MOCK_TOKEN, accountId: MOCK_ACCOUNT, zone: MOCK_ZONE },
      new AbortController().signal
    );
    assert.equal(checks[0]!.status, "ok");
  } finally {
    await s.close();
  }
});

test("discover lists what the token can see without storing it", async () => {
  const s = await setup({ connected: false });
  try {
    s.cf.state.tunnels.push({
      id: "11111111-1111-4111-8111-111111111111",
      account_tag: MOCK_ACCOUNT,
      name: "home",
      status: "healthy",
      config_src: "cloudflare",
      deleted_at: null,
      config: null,
      token: "t",
    });
    const { body } = await s.call<CloudflareDiscovery>("POST", "/discover", { token: MOCK_TOKEN });
    assert.equal(body.tokenStatus, "active");
    assert.deepEqual(body.accounts, [{ id: MOCK_ACCOUNT, name: "Example account" }]);
    assert.deepEqual(body.zones, [{ id: "zone-1", name: MOCK_ZONE, accountId: MOCK_ACCOUNT }]);
    assert.equal(body.tunnels[0]!.name, "home");
    assert.equal(s.m.secrets.size, 0);
    assert.equal((await s.call("POST", "/discover", { token: "bad" })).status, 400);
  } finally {
    await s.close();
  }
});

test("without a connector the view is empty and actions are 409", async () => {
  const s = await setup({ connected: false });
  try {
    const { body } = await s.call<CloudflareView>("GET", "/view");
    assert.deepEqual(body, { accessPolicy: "never", hosts: [] });
    assert.equal((await s.call("POST", "/sync")).status, 409);
    assert.equal((await s.call("POST", "/tunnel", {})).status, 409);
  } finally {
    await s.close();
  }
});

test("creates a tunnel, then a route and proxied CNAME per app", async () => {
  const s = await setup();
  try {
    let { body } = await s.call<CloudflareView>("POST", "/sync");
    assert.equal(hostOf(body, `grafana.${MOCK_ZONE}`).status, "warn");
    assert.match(hostOf(body, `grafana.${MOCK_ZONE}`).detail, /No tunnel yet/);

    ({ body } = await s.call<CloudflareView>("POST", "/tunnel", {}));
    const tunnel = s.cf.state.tunnels[0]!;
    assert.equal(tunnel.name, product.slug);
    assert.equal(tunnel.config_src, "cloudflare");
    assert.deepEqual(body.tunnel, { id: tunnel.id, name: product.slug, status: "inactive", adopted: false });

    assert.deepEqual(tunnel.config?.ingress, [
      { hostname: `grafana.${MOCK_ZONE}`, service: INGRESS },
      { hostname: `gitea.${MOCK_ZONE}`, service: INGRESS },
      { service: "http_status:404" },
    ]);
    const grafana = s.cf.state.dns.find((r) => r.name === `grafana.${MOCK_ZONE}`)!;
    assert.equal(grafana.type, "CNAME");
    assert.equal(grafana.content, `${tunnel.id}.cfargotunnel.com`);
    assert.equal(grafana.proxied, true);
    assert.equal(grafana.comment, TAG);
    const view = hostOf(body, `grafana.${MOCK_ZONE}`);
    assert.equal(view.status, "ok");
    assert.equal(view.route!.state, "in-sync");
    assert.equal(view.dns.state, "in-sync");

    const report = s.registry.reports.get("cn_1")!;
    assert.equal(report.items.length, 4);
    assert.ok(report.items.every((i) => i.state === "in-sync"));
  } finally {
    await s.close();
  }
});

test("adopts an existing tunnel and keeps its other routes, ours first", async () => {
  const state = mockCloudflareState();
  const id = "22222222-2222-4222-8222-222222222222";
  state.tunnels.push({
    id,
    account_tag: MOCK_ACCOUNT,
    name: "home",
    status: "healthy",
    config_src: "cloudflare",
    deleted_at: null,
    config: { ingress: [{ hostname: `*.${MOCK_ZONE}`, service: INGRESS }, { service: "http_status:404" }] },
    token: "tok",
  });
  const s = await setup({ state });
  try {
    const { body } = await s.call<CloudflareView>("POST", "/tunnel", { tunnelId: id });
    assert.equal(body.tunnel!.adopted, true);
    assert.deepEqual(
      state.tunnels[0]!.config!.ingress!.map((r) => r.hostname),
      [`grafana.${MOCK_ZONE}`, `gitea.${MOCK_ZONE}`, `*.${MOCK_ZONE}`, undefined]
    );
  } finally {
    await s.close();
  }
});

test("a record or route someone else made is reported and left alone", async () => {
  const state = mockCloudflareState();
  state.dns.push({
    id: "theirs",
    zone_id: "zone-1",
    type: "A",
    name: `gitea.${MOCK_ZONE}`,
    content: "10.0.0.20",
    proxied: false,
    ttl: 1,
    comment: null,
  });
  const s = await setup({ state });
  try {
    await s.call("POST", "/tunnel", {});
    const tunnel = state.tunnels[0]!;
    tunnel.config!.ingress!.splice(0, 0, { hostname: `grafana.${MOCK_ZONE}`, service: "http://elsewhere:80" });
    state.dns.splice(
      state.dns.findIndex((r) => r.name === `grafana.${MOCK_ZONE}`),
      1
    );
    // Forget our route so the edited one reads as someone else's.
    s.registry.owned("cn_1").delete(`grafana.${MOCK_ZONE}`, "cf-tunnel-route");
    const { body } = await s.call<CloudflareView>("POST", "/sync");

    const gitea = hostOf(body, `gitea.${MOCK_ZONE}`);
    assert.equal(gitea.status, "crit");
    assert.equal(gitea.dns.state, "conflict-unowned");
    assert.equal(state.dns.find((r) => r.id === "theirs")!.content, "10.0.0.20");

    const grafana = hostOf(body, `grafana.${MOCK_ZONE}`);
    assert.equal(grafana.route!.state, "conflict-unowned");
    assert.equal(
      tunnel.config!.ingress!.find((r) => r.hostname === `grafana.${MOCK_ZONE}`)!.service,
      "http://elsewhere:80"
    );
  } finally {
    await s.close();
  }
});

test("puts back a record changed outside and reports the drift", async () => {
  const s = await setup();
  try {
    await s.call("POST", "/tunnel", {});
    const record = s.cf.state.dns.find((r) => r.name === `grafana.${MOCK_ZONE}`)!;
    record.proxied = false;
    const route = s.cf.state.tunnels[0]!.config!.ingress![0]!;
    route.service = "http://changed:80";
    await s.call("POST", "/sync");
    const report = s.registry.reports.get("cn_1")!;
    const dns = report.items.find((i) => i.kind === "cf-dns-record" && i.key === `grafana.${MOCK_ZONE}`)!;
    assert.equal(dns.state, "drifted");
    assert.deepEqual(dns.diff, [{ path: "proxied", want: true, have: false }]);
    assert.equal(record.proxied, true);
    const routeItem = report.items.find((i) => i.kind === "cf-tunnel-route" && i.key === `grafana.${MOCK_ZONE}`)!;
    assert.equal(routeItem.state, "drifted");
    assert.equal(s.cf.state.tunnels[0]!.config!.ingress![0]!.service, INGRESS);

    s.cf.state.dns.splice(s.cf.state.dns.indexOf(record), 1);
    await s.call("POST", "/sync");
    assert.equal(
      s.registry.reports.get("cn_1")!.items.find((i) => i.kind === "cf-dns-record" && i.key === `grafana.${MOCK_ZONE}`)!
        .state,
      "missing"
    );
    assert.ok(s.cf.state.dns.some((r) => r.name === `grafana.${MOCK_ZONE}`));
  } finally {
    await s.close();
  }
});

test("a removed app loses its record and route; other records stay", async () => {
  const s = await setup();
  try {
    await s.call("POST", "/tunnel", {});
    s.cf.state.dns.push({
      id: "keep",
      zone_id: "zone-1",
      type: "A",
      name: `nas.${MOCK_ZONE}`,
      content: "10.0.0.5",
      proxied: false,
      ttl: 1,
      comment: null,
    });
    s.setAccess(access({ hosts: [{ appId: "grafana", host: `grafana.${MOCK_ZONE}`, url: "" }] }));
    await s.call("POST", "/sync");
    assert.deepEqual(s.cf.state.dns.map((r) => r.name).toSorted(), [`grafana.${MOCK_ZONE}`, `nas.${MOCK_ZONE}`]);
    assert.deepEqual(
      s.cf.state.tunnels[0]!.config!.ingress!.map((r) => r.hostname),
      [`grafana.${MOCK_ZONE}`, undefined]
    );
  } finally {
    await s.close();
  }
});

test("an Access step on local or unset changes nothing in Cloudflare", async () => {
  const s = await setup();
  try {
    await s.call("POST", "/tunnel", {});
    const before = s.cf.state.dns.length;
    s.setAccess({ mode: "local", baseDomain: MOCK_ZONE, hosts: [] });
    const { body } = await s.call<CloudflareView>("POST", "/sync");
    assert.match(body.error!, /set to local/);
    assert.equal(s.cf.state.dns.length, before);
  } finally {
    await s.close();
  }
});

test("direct exposure swaps the CNAME for a DNS-only A record and drops the route", async () => {
  const s = await setup({ config: { publicAddress: "203.0.113.7" } });
  try {
    await s.call("POST", "/tunnel", {});
    const { status, body } = await s.call<CloudflareHostView>("PUT", `/hosts/gitea.${MOCK_ZONE}`, {
      exposure: "direct",
    });
    assert.equal(status, 200);
    assert.equal(body.exposure, "direct");
    assert.equal(body.route, undefined);
    const record = s.cf.state.dns.find((r) => r.name === `gitea.${MOCK_ZONE}`)!;
    assert.deepEqual([record.type, record.content, record.proxied], ["A", "203.0.113.7", false]);
    assert.ok(!s.cf.state.tunnels[0]!.config!.ingress!.some((r) => r.hostname === `gitea.${MOCK_ZONE}`));
    assert.equal((await s.call("PUT", "/hosts/unknown.example.test", { exposure: "direct" })).status, 404);
  } finally {
    await s.close();
  }
});

test("a direct app gets a certificate Ingress through the deploy runner, removed when it goes back", async () => {
  const s = await setup({ config: { publicAddress: "203.0.113.7" } });
  try {
    await s.call("POST", "/tunnel", {});
    let { body } = await s.call<CloudflareHostView>("PUT", `/hosts/gitea.${MOCK_ZONE}`, { exposure: "direct" });
    assert.equal(body.status, "warn");
    assert.match(body.detail, /Requesting a certificate/);
    const name = `${product.ownerMarker.externalPrefix}direct-gitea`;
    assert.equal(s.deploy.started.length, 1);
    const started = s.deploy.started[0]!;
    assert.equal(started.entry.id, "direct-tls");
    assert.equal(started.request.namespace, "gitea");
    assert.deepEqual(started.request.inputs, {
      name,
      domain: `gitea.${MOCK_ZONE}`,
      service: "gitea-http",
      port: "3000",
      ingressClass: "traefik",
      issuer: "letsencrypt-prod",
      remove: false,
    });

    s.k8s.upsert(RESOURCES.ingresses, { metadata: { name, namespace: "gitea" }, spec: {} });
    s.k8s.upsert(RESOURCES.certificates, {
      metadata: { name: `${name}-tls`, namespace: "gitea" },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    });
    const { body: view } = await s.call<CloudflareView>("POST", "/sync");
    body = hostOf(view, `gitea.${MOCK_ZONE}`);
    assert.equal(body.status, "ok");
    assert.match(body.detail, /certificate from cert-manager/);
    assert.equal(s.deploy.started.length, 1);

    await s.call("PUT", `/hosts/gitea.${MOCK_ZONE}`, { exposure: "tunnel" });
    assert.equal(s.deploy.started.length, 2);
    assert.equal(s.deploy.started[1]!.request.inputs.remove, true);
  } finally {
    await s.close();
  }
});

test("direct without a cert-manager issuer says the certificate is missing", async () => {
  const s = await setup({ config: { publicAddress: "203.0.113.7" }, issuer: null });
  try {
    await s.call("POST", "/tunnel", {});
    const { body } = await s.call<CloudflareHostView>("PUT", `/hosts/gitea.${MOCK_ZONE}`, { exposure: "direct" });
    assert.equal(body.status, "warn");
    assert.match(body.detail, /No cert-manager ClusterIssuer/);
    assert.equal(s.deploy.started.length, 0);
  } finally {
    await s.close();
  }
});

test("direct without a public address waits and says what to set", async () => {
  const s = await setup();
  try {
    await s.call("POST", "/tunnel", {});
    const { body } = await s.call<CloudflareHostView>("PUT", `/hosts/gitea.${MOCK_ZONE}`, { exposure: "direct" });
    assert.equal(body.dns.state, "pending");
    assert.match(body.detail, /public address/);
  } finally {
    await s.close();
  }
});

test("Access apps follow the setting: per app, then off removes them", async () => {
  const s = await setup({
    config: { accessEmails: "me@example.test, @example.test" },
    settings: { "connector-cloudflare.accessApps": "per-app" },
  });
  try {
    await s.call("POST", "/tunnel", {});
    assert.equal(s.cf.state.accessApps.length, 0);
    const { body } = await s.call<CloudflareHostView>("PUT", `/hosts/grafana.${MOCK_ZONE}`, { access: true });
    assert.equal(body.accessApp!.state, "in-sync");
    assert.match(body.detail, /Access/);
    const app = s.cf.state.accessApps[0]!;
    assert.equal(app.domain, `grafana.${MOCK_ZONE}`);
    assert.equal(app.name, `${product.ownerMarker.externalPrefix}grafana.${MOCK_ZONE}`);
    assert.deepEqual(app.policies[0]!.include, [
      { email: { email: "me@example.test" } },
      { email_domain: { domain: "example.test" } },
    ]);
    await s.call("PUT", `/hosts/grafana.${MOCK_ZONE}`, { access: false });
    assert.equal(s.cf.state.accessApps.length, 0);
  } finally {
    await s.close();
  }
});

test("Access always without an allow list waits rather than locking everyone out", async () => {
  const s = await setup({ settings: { "connector-cloudflare.accessApps": "always" } });
  try {
    const { body } = await s.call<CloudflareView>("POST", "/tunnel", {});
    assert.equal(s.cf.state.accessApps.length, 0);
    assert.equal(hostOf(body, `grafana.${MOCK_ZONE}`).accessApp!.state, "pending");
  } finally {
    await s.close();
  }
});

test("someone else's Access app on a host is left alone", async () => {
  const state = mockCloudflareState();
  state.accessApps.push({
    id: "app-theirs",
    account: MOCK_ACCOUNT,
    name: "My grafana",
    domain: `grafana.${MOCK_ZONE}`,
    type: "self_hosted",
    session_duration: "24h",
    policies: [],
  });
  const s = await setup({
    state,
    config: { accessEmails: "me@example.test" },
    settings: { "connector-cloudflare.accessApps": "always" },
  });
  try {
    const { body } = await s.call<CloudflareView>("POST", "/tunnel", {});
    assert.equal(hostOf(body, `grafana.${MOCK_ZONE}`).accessApp!.state, "conflict-unowned");
    assert.equal(state.accessApps.find((a) => a.id === "app-theirs")!.name, "My grafana");
    assert.equal(hostOf(body, `gitea.${MOCK_ZONE}`).accessApp!.state, "in-sync");
  } finally {
    await s.close();
  }
});

test("cleanup removes records, routes and Access apps but keeps the tunnel", async () => {
  const s = await setup({
    config: { accessEmails: "me@example.test" },
    settings: { "connector-cloudflare.accessApps": "always" },
  });
  try {
    await s.call("POST", "/tunnel", {});
    s.cf.state.dns.push({
      id: "keep",
      zone_id: "zone-1",
      type: "A",
      name: `nas.${MOCK_ZONE}`,
      content: "10.0.0.5",
      proxied: false,
      ttl: 1,
      comment: null,
    });
    const result = await s.kind.cleanup!((await s.registry.instance("cn_1"))!, s.registry.owned("cn_1"));
    assert.deepEqual(result, { removed: 6, errors: [] });
    assert.deepEqual(
      s.cf.state.dns.map((r) => r.id),
      ["keep"]
    );
    assert.equal(s.cf.state.accessApps.length, 0);
    assert.deepEqual(s.cf.state.tunnels[0]!.config!.ingress, [{ service: "http_status:404" }]);
    assert.equal(s.cf.state.tunnels.length, 1);
  } finally {
    await s.close();
  }
});

test("tunnel deploy starts cloudflared with the token server-side", async () => {
  const s = await setup();
  try {
    assert.equal((await s.call("POST", "/tunnel/deploy")).status, 409);
    await s.call("POST", "/tunnel", {});
    const { status, body } = await s.call<DeployJobView>("POST", "/tunnel/deploy");
    assert.equal(status, 200);
    assert.equal(body.appId, "cloudflared");
    const call = s.m.calls.find((c) => c.key === "POST /api/deploy/jobs")!;
    assert.deepEqual(call.input.body, {
      appId: "cloudflared",
      mode: "install",
      inputs: { tunnelToken: s.cf.state.tunnels[0]!.token },
    });
    assert.ok(!JSON.stringify(s.m.audit).includes(s.cf.state.tunnels[0]!.token));
  } finally {
    await s.close();
  }
});

test("the connector's Tunnel ID field wins over picking one here", async () => {
  const s = await setup({ config: { tunnelId: "33333333-3333-4333-8333-333333333333" } });
  try {
    assert.equal((await s.call("POST", "/tunnel", {})).status, 409);
  } finally {
    await s.close();
  }
});

test("a finished deploy brings its new host in", async () => {
  const s = await setup();
  try {
    await s.call("POST", "/tunnel", {});
    s.setAccess(
      access({
        hosts: [...access().hosts, { appId: "ntfy", host: `ntfy.${MOCK_ZONE}`, url: "" }],
      })
    );
    s.m.ctx.bus.emit("deploy.finished", { jobId: "dj_1", appId: "ntfy", mode: "install", state: "succeeded" });
    const deadline = Date.now() + 10_000;
    while (!s.cf.state.dns.some((r) => r.name === `ntfy.${MOCK_ZONE}`) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(s.cf.state.dns.some((r) => r.name === `ntfy.${MOCK_ZONE}`));
  } finally {
    await s.close();
  }
});

import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, test } from "node:test";
import type { AuditRow, AuthentikWirePlan, AuthentikWireResult } from "../../src/contracts/auth.js";
import { authentikUrlProblem } from "../../src/platform/auth/authentik.js";
import { product } from "../../src/product.js";
import { boot, type Booted } from "./harness.js";

// Just enough of Authentik's API v3 to wire against: one admin token, the
// default flows, scope mappings and signing key, and in-memory providers and
// applications. Every request is recorded so tests can see what was sent.
interface FakeAuthentik {
  url: string;
  token: string;
  providers: Map<number, Record<string, unknown>>;
  applications: Map<string, Record<string, unknown>>;
  requests: Array<{ method: string; path: string; auth: string; body: unknown }>;
  close(): Promise<void>;
}

const page = (results: unknown[]) => ({ pagination: { count: results.length }, results });

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function fakeAuthentik(token = "ak-admin-token"): Promise<FakeAuthentik> {
  let base = "";
  let nextPk = 1;
  const providers = new Map<number, Record<string, unknown>>();
  const applications = new Map<string, Record<string, unknown>>();
  const requests: FakeAuthentik["requests"] = [];

  const server: Server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", base);
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({
        method: req.method ?? "",
        path: url.pathname + url.search,
        auth: req.headers.authorization ?? "",
        body,
      });
      const discovery = url.pathname.match(/^\/application\/o\/([^/]+)\/\.well-known\/openid-configuration$/);
      if (discovery) {
        const issuer = `${base}/application/o/${discovery[1]}/`;
        return applications.has(discovery[1]!)
          ? sendJson(res, 200, {
              issuer,
              authorization_endpoint: `${base}/application/o/authorize/`,
              token_endpoint: `${base}/application/o/token/`,
            })
          : sendJson(res, 404, { detail: "Not found." });
      }
      if (req.headers.authorization !== `Bearer ${token}`)
        return sendJson(res, 403, { detail: "Token invalid/expired" });
      const path = url.pathname.replace(/^\/api\/v3/, "");
      const q = url.searchParams;
      if (path === "/flows/instances/") {
        const flows = [
          { pk: "flow-authz", slug: "default-provider-authorization-implicit-consent", designation: "authorization" },
          { pk: "flow-inval", slug: "default-provider-invalidation-flow", designation: "invalidation" },
        ];
        return sendJson(
          res,
          200,
          page(flows.filter((f) => (q.get("slug") ? f.slug === q.get("slug") : f.designation === q.get("designation"))))
        );
      }
      if (path === "/propertymappings/provider/scope/") {
        const managed = q.get("managed") ?? "";
        return sendJson(res, 200, page([{ pk: `map-${managed.split("scope-")[1]}`, managed }]));
      }
      if (path === "/crypto/certificatekeypairs/")
        return sendJson(res, 200, page([{ pk: "key-1", name: "authentik Self-signed Certificate" }]));
      if (path === "/providers/oauth2/" && req.method === "GET") {
        return sendJson(res, 200, page([...providers.values()].filter((p) => p.name === q.get("name"))));
      }
      if (path === "/providers/oauth2/" && req.method === "POST") {
        const pk = nextPk++;
        const provider = { ...body, pk, client_id: `client-${pk}`, client_secret: `secret-${pk}` };
        providers.set(pk, provider);
        return sendJson(res, 201, provider);
      }
      const providerPath = path.match(/^\/providers\/oauth2\/(\d+)\/$/);
      if (providerPath) {
        const provider = providers.get(Number(providerPath[1]));
        if (!provider) return sendJson(res, 404, { detail: "Not found." });
        if (req.method === "PATCH") Object.assign(provider, body);
        return sendJson(res, 200, provider);
      }
      if (path === "/core/applications/" && req.method === "POST") {
        applications.set(body.slug, { ...body });
        return sendJson(res, 201, body);
      }
      const appPath = path.match(/^\/core\/applications\/([^/]+)\/$/);
      if (appPath) {
        const app = applications.get(appPath[1]!);
        if (!app) return sendJson(res, 404, { detail: "Not found." });
        if (req.method === "PATCH") Object.assign(app, body);
        return sendJson(res, 200, app);
      }
      sendJson(res, 404, { detail: "Not found." });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    token,
    providers,
    applications,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

let app: Booted;
let authentik: FakeAuthentik;
let cookie = "";

beforeEach(async () => {
  app = await boot();
  authentik = await fakeAuthentik();
  await app.makeUser("root", "root password!!", { role: "admin" });
  cookie = (await app.login("root", "root password!!")).cookie;
});
afterEach(async () => {
  await authentik.close();
  await app.close();
});

const wire = (body: Record<string, unknown>, as = cookie) => app.send("POST", "/api/admin/oidc/authentik", body, as);
const secretOf = (id: string) =>
  app.db.prepare("SELECT 1 FROM secrets WHERE scope = 'auth' AND id = ?").get(id) !== undefined;

test("the plan names what will be created and where people return to", async () => {
  const res = await app.get(`/api/admin/oidc/authentik?url=${encodeURIComponent(authentik.url + "/")}`, cookie);
  assert.equal(res.status, 200);
  const plan = (await res.json()) as AuthentikWirePlan;
  assert.deepEqual(plan, {
    authentikUrl: authentik.url,
    applicationName: product.displayName,
    slug: product.slug,
    redirectUri: `${app.url}/auth/oidc/callback`,
    issuer: `${authentik.url}/application/o/${product.slug}/`,
    hasStoredToken: false,
    blocked: null,
  });
  assert.equal((await app.get("/api/admin/oidc/authentik?url=http://auth.example.test", cookie)).status, 400);
  assert.equal((await app.get("/api/admin/oidc/authentik", cookie)).status, 400);
});

test("wiring creates the provider and application, saves the settings and secret, and drops the token", async () => {
  const res = await wire({ authentikUrl: authentik.url, token: authentik.token, adminGroups: ["authentik Admins"] });
  assert.equal(res.status, 200);
  const result = (await res.json()) as AuthentikWireResult;
  assert.equal(result.application, "created");
  assert.equal(result.provider, "created");
  assert.equal(result.clientId, "client-1");
  assert.equal(result.issuer, `${authentik.url}/application/o/${product.slug}/`);
  assert.deepEqual(result.discovery, { ok: true });
  assert.equal(result.tokenKept, false);
  assert.equal(result.testSignIn, "auth/oidc/start?link=1");
  assert.ok(!JSON.stringify(result).includes("secret-1"), "the client secret is never returned");

  const provider = authentik.providers.get(1)!;
  assert.equal(provider.authorization_flow, "flow-authz");
  assert.equal(provider.invalidation_flow, "flow-inval");
  assert.equal(provider.client_type, "confidential");
  assert.equal(provider.signing_key, "key-1");
  assert.deepEqual(provider.property_mappings, ["map-openid", "map-email", "map-profile"]);
  assert.deepEqual(provider.redirect_uris, [{ matching_mode: "strict", url: `${app.url}/auth/oidc/callback` }]);
  assert.deepEqual(authentik.applications.get(product.slug), {
    name: product.displayName,
    slug: product.slug,
    provider: 1,
    meta_launch_url: app.url,
  });

  assert.equal(app.settings.string("auth.oidc.issuer"), result.issuer.replace(/\/$/, ""));
  assert.equal(app.settings.string("auth.oidc.clientId"), "client-1");
  assert.equal(app.settings.bool("auth.oidc.enabled"), true);
  assert.deepEqual(app.settings.list("auth.oidc.adminGroups"), ["authentik Admins"]);
  assert.ok(secretOf("oidc"));
  assert.ok(!secretOf("authentik-api"));

  const overview = (await (await app.get("/api/admin/overview", cookie)).json()) as {
    oidc: { unavailable: string | null };
  };
  assert.equal(overview.oidc.unavailable, null);

  const audit = (await (await app.get("/api/admin/audit", cookie)).json()) as AuditRow[];
  const row = audit.find((r) => r.action === "admin.oidc-authentik-wire")!;
  assert.match(row.detail, /application=created provider=created token=discarded/);
  assert.ok(!audit.some((r) => r.detail.includes(authentik.token) || r.detail.includes("secret-1")));
});

test("a re-run finds the application by slug and creates nothing", async () => {
  assert.equal((await wire({ authentikUrl: authentik.url, token: authentik.token, keepToken: true })).status, 200);
  assert.ok(secretOf("authentik-api"));
  authentik.requests.length = 0;

  const res = await wire({ authentikUrl: authentik.url });
  assert.equal(res.status, 200, "the kept token is used");
  const result = (await res.json()) as AuthentikWireResult;
  assert.equal(result.application, "found");
  assert.equal(result.provider, "unchanged");
  assert.equal(result.clientId, "client-1");
  assert.equal(authentik.providers.size, 1);
  assert.ok(!authentik.requests.some((r) => r.method !== "GET"));
  assert.ok(!secretOf("authentik-api"), "keepToken left out discards the stored token");
});

test("a provider missing the redirect URI gets it added, and a half-finished run is completed", async () => {
  authentik.providers.set(7, {
    pk: 7,
    name: product.displayName,
    client_id: "client-7",
    client_secret: "secret-7",
    redirect_uris: [{ matching_mode: "strict", url: "https://old.example.test/auth/oidc/callback" }],
  });
  const result = (await (
    await wire({ authentikUrl: authentik.url, token: authentik.token })
  ).json()) as AuthentikWireResult;
  assert.equal(result.provider, "updated");
  assert.equal(result.application, "created");
  assert.equal(result.clientId, "client-7");
  assert.equal((authentik.providers.get(7)!.redirect_uris as unknown[]).length, 2);
  assert.equal(authentik.applications.get(product.slug)!.provider, 7);
});

test("a refused token, a missing token and a missing public URL are explained", async () => {
  const refused = await wire({ authentikUrl: authentik.url, token: "wrong" });
  assert.equal(refused.status, 502);
  assert.match(((await refused.json()) as { error: string }).error, /refused the token \(403\)/);
  assert.equal(app.settings.string("auth.oidc.clientId"), "");

  assert.equal((await wire({ authentikUrl: authentik.url })).status, 400);

  delete process.env.PUBLIC_ORIGIN;
  const noUrl = await wire({ authentikUrl: authentik.url, token: authentik.token });
  assert.equal(noUrl.status, 400);
  assert.match(((await noUrl.json()) as { error: string }).error, /public URL/);
  assert.equal(authentik.requests.length, 1);
});

test("only admins may wire", async () => {
  await app.makeUser("plain", "plain password!");
  const plain = (await app.login("plain", "plain password!")).cookie;
  assert.equal((await wire({ authentikUrl: authentik.url, token: authentik.token }, plain)).status, 403);
  assert.equal(authentik.requests.length, 0);
});

test("the API may be called over http only at a cluster Service or this machine", () => {
  assert.equal(authentikUrlProblem("http://authentik-server.authentik.svc:80", "api"), null);
  assert.equal(authentikUrlProblem("http://authentik-server.authentik.svc.cluster.local", "api"), null);
  assert.equal(authentikUrlProblem("http://127.0.0.1:9000", "api"), null);
  assert.equal(authentikUrlProblem("https://auth.example.test", "api"), null);
  assert.match(authentikUrlProblem("http://auth.example.test", "api")!, /in-cluster Service/);
  assert.match(authentikUrlProblem("http://svc.example.test", "api")!, /in-cluster Service/);
  assert.equal(authentikUrlProblem("http://auth.example.test", "public"), null);
  assert.ok(authentikUrlProblem("ftp://auth.example.test", "public"));
});

test("with an apiUrl the token goes there and the issuer is built on the public URL", async () => {
  const publicUrl = "http://auth.example.test";
  const plan = (await (
    await app.get(`/api/admin/oidc/authentik?url=${publicUrl}&apiUrl=${encodeURIComponent(authentik.url)}`, cookie)
  ).json()) as AuthentikWirePlan;
  assert.equal(plan.apiUrl, authentik.url);
  assert.equal(plan.issuer, `${publicUrl}/application/o/${product.slug}/`);

  const res = await wire({ authentikUrl: publicUrl, apiUrl: authentik.url, token: authentik.token });
  assert.equal(res.status, 200);
  const result = (await res.json()) as AuthentikWireResult;
  assert.equal(result.issuer, `${publicUrl}/application/o/${product.slug}/`);
  assert.equal(result.discovery.ok, false, "http issuers are refused by sign-in, and the result says why");
  assert.equal(authentik.applications.get(product.slug)!.provider, 1);
  assert.ok(authentik.requests.every((r) => r.auth === `Bearer ${authentik.token}`));
});

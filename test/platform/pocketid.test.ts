import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, test } from "node:test";
import type { AuditRow, PocketIdWirePlan, PocketIdWireResult } from "../../src/contracts/auth.js";
import { pocketIdUrlProblem } from "../../src/platform/auth/pocketid.js";
import { product } from "../../src/product.js";
import { boot, type Booted } from "./harness.js";

// Just enough of Pocket ID's API to wire against: one admin API key and
// in-memory OIDC clients with their secrets. Every request is recorded.
interface FakePocketId {
  url: string;
  apiKey: string;
  clients: Map<string, Record<string, unknown>>;
  secrets: Map<string, string[]>;
  requests: Array<{ method: string; path: string; key: string; body: unknown }>;
  close(): Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

// Newer Pocket ID releases return a secret with the created client.
let secretOnCreate = false;

async function fakePocketId(apiKey = "pid-admin-key"): Promise<FakePocketId> {
  let base = "";
  let nextSecret = 1;
  const clients = new Map<string, Record<string, unknown>>();
  const secrets = new Map<string, string[]>();
  const requests: FakePocketId["requests"] = [];
  const newSecret = (id: string) => {
    const value = `secret-${nextSecret++}`;
    secrets.set(id, [...(secrets.get(id) ?? []), value]);
    return value;
  };

  const server: Server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", base);
      const body = raw ? JSON.parse(raw) : undefined;
      const key = String(req.headers["x-api-key"] ?? "");
      requests.push({ method: req.method ?? "", path: url.pathname, key, body });
      if (url.pathname === "/.well-known/openid-configuration") {
        return sendJson(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/api/oidc/token`,
        });
      }
      if (key !== apiKey) return sendJson(res, 401, { error: "You are not signed in" });
      if (url.pathname === "/api/oidc/clients" && req.method === "POST") {
        const client = { ...body, credentials: { secrets: [] } };
        clients.set(body.id, client);
        return sendJson(
          res,
          201,
          secretOnCreate ? { ...client, createdSecret: { secret: newSecret(body.id) } } : client
        );
      }
      const secretPath = url.pathname.match(/^\/api\/oidc\/clients\/([^/]+)\/secrets$/);
      if (secretPath && req.method === "POST") {
        if (!clients.has(secretPath[1]!)) return sendJson(res, 404, { error: "Not found" });
        return sendJson(res, 201, { id: `s${nextSecret}`, secret: newSecret(secretPath[1]!) });
      }
      const clientPath = url.pathname.match(/^\/api\/oidc\/clients\/([^/]+)$/);
      if (clientPath) {
        const client = clients.get(decodeURIComponent(clientPath[1]!));
        if (!client) return sendJson(res, 404, { error: "Record not found" });
        if (req.method === "PUT") Object.assign(client, body);
        return sendJson(res, 200, client);
      }
      sendJson(res, 404, { error: "Not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    apiKey,
    clients,
    secrets,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

let app: Booted;
let pocket: FakePocketId;
let cookie = "";

beforeEach(async () => {
  secretOnCreate = false;
  app = await boot();
  pocket = await fakePocketId();
  await app.makeUser("root", "root password!!", { role: "admin" });
  cookie = (await app.login("root", "root password!!")).cookie;
});
afterEach(async () => {
  await pocket.close();
  await app.close();
});

const wire = (body: Record<string, unknown>, as = cookie) => app.send("POST", "/api/admin/oidc/pocket-id", body, as);
const secretOf = (id: string) =>
  app.db.prepare("SELECT 1 FROM secrets WHERE scope = 'auth' AND id = ?").get(id) !== undefined;

test("the plan names the client and where people return to", async () => {
  const res = await app.get(`/api/admin/oidc/pocket-id?url=${encodeURIComponent(pocket.url + "/")}`, cookie);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as PocketIdWirePlan, {
    pocketIdUrl: pocket.url,
    clientName: product.displayName,
    clientId: product.slug,
    redirectUri: `${app.url}/auth/oidc/callback`,
    issuer: pocket.url,
    hasStoredKey: false,
    blocked: null,
  });
  assert.equal((await app.get("/api/admin/oidc/pocket-id", cookie)).status, 400);
});

test("wiring creates the client and a secret, saves the settings, and drops the key", async () => {
  const res = await wire({ pocketIdUrl: pocket.url, apiKey: pocket.apiKey, adminGroups: ["admins"] });
  assert.equal(res.status, 200);
  const result = (await res.json()) as PocketIdWireResult;
  assert.equal(result.client, "created");
  assert.equal(result.clientId, product.slug);
  assert.equal(result.issuer, pocket.url);
  assert.deepEqual(result.discovery, { ok: true });
  assert.equal(result.keyKept, false);
  assert.ok(!JSON.stringify(result).includes("secret-1"), "the client secret is never returned");

  const client = pocket.clients.get(product.slug)!;
  assert.equal(client.name, product.displayName);
  assert.deepEqual(client.callbackURLs, [`${app.url}/auth/oidc/callback`]);
  assert.equal(client.launchURL, app.url);
  assert.equal(client.isPublic, false);
  assert.equal(client.pkceEnabled, true);
  assert.deepEqual(pocket.secrets.get(product.slug), ["secret-1"]);

  assert.equal(app.settings.string("auth.oidc.issuer"), pocket.url);
  assert.equal(app.settings.string("auth.oidc.clientId"), product.slug);
  assert.equal(app.settings.string("auth.oidc.label"), "Sign in with Pocket ID");
  assert.equal(app.settings.bool("auth.oidc.enabled"), true);
  assert.deepEqual(app.settings.list("auth.oidc.adminGroups"), ["admins"]);
  assert.equal(app.settings.string("auth.oidc.scopes"), "openid profile email groups");
  assert.ok(result.settings.includes("auth.oidc.scopes"));
  assert.ok(secretOf("oidc"));
  assert.ok(!secretOf("pocket-id-api"));

  const audit = (await (await app.get("/api/admin/audit", cookie)).json()) as AuditRow[];
  const row = audit.find((r) => r.action === "admin.oidc-pocket-id-wire")!;
  assert.match(row.detail, /client=created key=discarded/);
  assert.ok(!audit.some((r) => r.detail.includes(pocket.apiKey) || r.detail.includes("secret-1")));
});

test("a re-run finds the client by its ID and only adds a secret", async () => {
  assert.equal((await wire({ pocketIdUrl: pocket.url, apiKey: pocket.apiKey, keepKey: true })).status, 200);
  assert.ok(secretOf("pocket-id-api"));
  pocket.requests.length = 0;

  const res = await wire({ pocketIdUrl: pocket.url });
  assert.equal(res.status, 200, "the kept key is used");
  const result = (await res.json()) as PocketIdWireResult;
  assert.equal(result.client, "unchanged");
  assert.equal(pocket.clients.size, 1);
  assert.deepEqual(
    pocket.requests.filter((r) => r.path.startsWith("/api")).map((r) => `${r.method} ${r.path}`),
    [`GET /api/oidc/clients/${product.slug}`, `POST /api/oidc/clients/${product.slug}/secrets`]
  );
  assert.deepEqual(pocket.secrets.get(product.slug), ["secret-1", "secret-2"]);
  assert.equal(app.settings.string("auth.oidc.scopes"), "openid profile email", "no admin groups, no groups scope");
  assert.ok(!secretOf("pocket-id-api"), "keepKey left out discards the stored key");
});

test("a client missing the redirect URI gets it added, keeping the rest", async () => {
  pocket.clients.set(product.slug, {
    id: product.slug,
    name: product.displayName,
    callbackURLs: ["https://old.example.test/auth/oidc/callback"],
    isPublic: false,
    pkceEnabled: true,
    credentials: { secrets: [] },
  });
  const result = (await (await wire({ pocketIdUrl: pocket.url, apiKey: pocket.apiKey })).json()) as PocketIdWireResult;
  assert.equal(result.client, "updated");
  assert.deepEqual(pocket.clients.get(product.slug)!.callbackURLs, [
    "https://old.example.test/auth/oidc/callback",
    `${app.url}/auth/oidc/callback`,
  ]);
});

test("a secret returned with the created client is used instead of adding another", async () => {
  secretOnCreate = true;
  assert.equal((await wire({ pocketIdUrl: pocket.url, apiKey: pocket.apiKey })).status, 200);
  assert.deepEqual(pocket.secrets.get(product.slug), ["secret-1"]);
  assert.ok(!pocket.requests.some((r) => r.path.endsWith("/secrets")));
});

test("a refused key, a missing key and a missing public URL are explained", async () => {
  const refused = await wire({ pocketIdUrl: pocket.url, apiKey: "wrong" });
  assert.equal(refused.status, 502);
  assert.match(((await refused.json()) as { error: string }).error, /refused the API key \(401\)/);
  assert.equal(app.settings.string("auth.oidc.clientId"), "");

  assert.equal((await wire({ pocketIdUrl: pocket.url })).status, 400);

  delete process.env.PUBLIC_ORIGIN;
  const noUrl = await wire({ pocketIdUrl: pocket.url, apiKey: pocket.apiKey });
  assert.equal(noUrl.status, 400);
  assert.match(((await noUrl.json()) as { error: string }).error, /public URL/);
  assert.equal(pocket.requests.length, 1);
});

test("only admins may wire", async () => {
  await app.makeUser("plain", "plain password!");
  const plain = (await app.login("plain", "plain password!")).cookie;
  assert.equal((await wire({ pocketIdUrl: pocket.url, apiKey: pocket.apiKey }, plain)).status, 403);
  assert.equal(pocket.requests.length, 0);
});

test("the API key goes to the apiUrl, and over http only to a cluster Service or this machine", async () => {
  assert.equal(pocketIdUrlProblem("http://pocket-id.pocket-id.svc:80", "api"), null);
  assert.match(pocketIdUrlProblem("http://id.example.test", "api")!, /Pocket ID's API must be reached/);
  assert.equal(pocketIdUrlProblem("http://id.example.test", "public"), null);

  const publicUrl = "https://id.example.test";
  const res = await wire({ pocketIdUrl: publicUrl, apiUrl: pocket.url, apiKey: pocket.apiKey });
  assert.equal(res.status, 200);
  const result = (await res.json()) as PocketIdWireResult;
  assert.equal(result.issuer, publicUrl);
  assert.equal(result.discovery.ok, false, "the public address isn't reachable from the test");
  assert.equal(pocket.clients.get(product.slug)!.launchURL, app.url);
  assert.ok(pocket.requests.filter((r) => r.path.startsWith("/api")).every((r) => r.key === pocket.apiKey));
});

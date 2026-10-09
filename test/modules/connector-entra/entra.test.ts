import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, test } from "node:test";
import type { ConnectorInstance, EntraGroup, EntraSignInView } from "../../../src/contracts/connectors.js";
import {
  createMockConnectorRegistry,
  type MockConnectorRegistry,
} from "../../../src/contracts/mocks/connectors/index.js";
import { createMockContext, mockAdmin, mockViewer, type MockContext } from "../../../src/contracts/mocks/context.js";
import { createMockSignIn, type MockSignIn } from "../../../src/contracts/mocks/signin.js";
import entra, { register } from "../../../src/modules/connector-entra/index.js";
import { DAY_MS, KIND, OWNED_KIND, SIGNIN_KEY, specOf } from "../../../src/modules/connector-entra/kind.js";
import { DELETE_SECRET_STEP, UPLOAD_STEP } from "../../../src/modules/connector-entra/management.js";
import { product } from "../../../src/product.js";
import { listen } from "../../runtime/helpers.js";
import { MGMT_CLIENT, MGMT_SECRET, TENANT, startFakeGraph, type FakeGraph } from "./fakeGraph.js";

const REDIRECT = "https://console.example.test/auth/oidc/callback";
const START = Date.parse("2026-10-08T12:00:00Z");

const instance = (secret = MGMT_SECRET): ConnectorInstance => ({
  id: "cn_e",
  kind: KIND,
  name: "Entra",
  config: { tenantId: TENANT, clientId: MGMT_CLIENT },
  secrets: { clientSecret: secret },
});

interface Setup {
  graph: FakeGraph;
  m: MockContext;
  registry: MockConnectorRegistry;
  signIn: MockSignIn;
  clock: { now: number };
  call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T & { error?: string } }>;
  close(): Promise<void>;
}

const open: Setup[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function setup(
  options: { connector?: boolean; redirectUri?: string; refuseKeys?: boolean } = {}
): Promise<Setup> {
  const graph = await startFakeGraph();
  graph.refuseKeys = options.refuseKeys;
  const registry = createMockConnectorRegistry(options.connector === false ? [] : [instance()]);
  const signIn = createMockSignIn({ redirectUri: options.redirectUri ?? REDIRECT });
  const m = createMockContext("connector-entra", {
    migrations: entra.migrations ?? [],
    services: { connectors: registry, signin: signIn },
  });
  const clock = { now: START };
  register(m.ctx, { endpoints: graph.endpoints, now: () => new Date(clock.now) });
  const server = await listen(m.app);
  const s: Setup = {
    graph,
    m,
    registry,
    signIn,
    clock,
    async call<T>(method: string, path: string, body?: unknown) {
      const res = await fetch(`${server.url}/api/connector-entra${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return {
        status: res.status,
        body: (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) as T & { error?: string },
      };
    },
    async close() {
      await server.close();
      await graph.close();
      await m.close();
    },
  };
  open.push(s);
  return s;
}

const kindOf = (s: Setup) => s.registry.kinds().find((k) => k.kind === KIND)!;
const signal = () => new AbortController().signal;
const values = (secret = MGMT_SECRET) => ({ tenantId: TENANT, clientId: MGMT_CLIENT, clientSecret: secret });
const byId = <T extends { id: string }>(list: T[], id: string) => list.find((c) => c.id === id);

test("registers one identity kind with the tenant, client and object ids and a bootstrap secret", async () => {
  const s = await setup();
  const kind = kindOf(s);
  assert.equal(kind.label, "Microsoft Entra ID");
  assert.deepEqual(kind.capabilities, ["identity"]);
  assert.equal(kind.single, true);
  assert.deepEqual(
    kind.fields.map((f) => [f.key, f.type, f.required]),
    [
      ["tenantId", "text", true],
      ["clientId", "text", true],
      ["objectId", "text", false],
      ["clientSecret", "secret", false],
    ]
  );
});

test("verify signs in to Graph and reports each permission and the redirect URI", async () => {
  const s = await setup();
  const checks = await kindOf(s).verify(values(), signal());
  assert.deepEqual(
    checks.map((c) => [c.id, c.status]),
    [
      ["graph", "ok"],
      ["permission", "ok"],
      ["groups", "ok"],
      ["redirect", "ok"],
    ]
  );
  assert.ok(checks.every((c) => c.detail));
  assert.doesNotMatch(JSON.stringify(checks), new RegExp(MGMT_SECRET));
});

test("a wrong secret is a crit with Entra's own reason, and never throws", async () => {
  const s = await setup();
  const checks = await kindOf(s).verify(values("wrong"), signal());
  const graph = byId(checks, "graph")!;
  assert.equal(graph.status, "crit");
  assert.match(graph.detail, /AADSTS7000215: Invalid client secret provided\.$/);
  assert.deepEqual((graph.raw as { status: number }).status, 401);
  assert.doesNotMatch(JSON.stringify(checks), /wrong/);

  const bad = await kindOf(s).verify({ ...values(), tenantId: "not a tenant/../x" }, signal());
  assert.equal(byId(bad, "graph")!.status, "crit");
  assert.match(byId(bad, "graph")!.detail, /GUID or a domain/);
});

test("a missing OwnedBy permission is a crit linking to admin consent; no group permission is optional", async () => {
  const s = await setup();
  s.graph.roles = [];
  const checks = await kindOf(s).verify(values(), signal());
  const permission = byId(checks, "permission")!;
  assert.equal(permission.status, "crit");
  assert.match(permission.detail, /Application\.ReadWrite\.OwnedBy/);
  assert.equal(permission.deepLink, `${s.graph.endpoints.login}/${TENANT}/adminconsent?client_id=${MGMT_CLIENT}`);
  assert.equal(byId(checks, "groups")!.status, "absent");
});

test("an http public URL is warned about: Entra refuses it", async () => {
  const s = await setup({ redirectUri: "http://10.0.0.5:32450/auth/oidc/callback" });
  const redirect = byId(await kindOf(s).verify(values(), signal()), "redirect")!;
  assert.equal(redirect.status, "warn");
  assert.match(redirect.detail, /http:\/\/10\.0\.0\.5:32450.*refuses http redirect URIs other than localhost/);

  const local = await setup({ redirectUri: "http://localhost:8080/auth/oidc/callback" });
  assert.equal(byId(await kindOf(local).verify(values(), signal()), "redirect")!.status, "ok");

  const unset = await setup({ redirectUri: "" });
  assert.match(byId(await kindOf(unset).verify(values(), signal()), "redirect")!.detail, /Set the public URL first/);

  const res = await s.call<EntraSignInView>("POST", "/signin", {});
  assert.equal(res.status, 400);
  assert.match(res.body.error ?? "", /refuses http redirect URIs/);
  assert.equal(s.graph.apps.size, 0);
  assert.equal(s.signIn.writes.length, 0);
});

const thumbprintOf = (pem: string) =>
  crypto.createHash("sha1").update(new crypto.X509Certificate(pem).raw).digest("hex").toUpperCase();

test("setting up sign-in creates the app registration with a certificate and points sign-in at its key", async () => {
  const s = await setup();
  const res = await s.call<EntraSignInView>("POST", "/signin", { adminGroups: ["g-admins", " g-admins "] });
  assert.equal(res.status, 200, res.body.error);

  assert.equal(s.graph.apps.size, 1);
  const app = [...s.graph.apps.values()][0]!;
  assert.deepEqual(app.web.redirectUris, [REDIRECT]);
  assert.equal(app.displayName, `${product.displayName} sign-in`);
  assert.deepEqual(app.tags, [product.ownerMarker.externalTag]);
  assert.equal(app.groupMembershipClaims, "SecurityGroup");
  assert.equal(app.body.signInAudience, "AzureADMyOrg");
  assert.equal(app.passwordCredentials.length, 0);
  assert.equal(app.keyCredentials.length, 1);

  assert.equal(s.signIn.writes.length, 1);
  const { client, actor } = s.signIn.writes[0]!;
  assert.equal(actor, "admin");
  const { clientKey, ...rest } = client;
  assert.deepEqual(rest, {
    issuer: `${s.graph.endpoints.login}/${TENANT}/v2.0`,
    clientId: app.appId,
    label: "Sign in with Microsoft",
    enabled: true,
    adminGroups: ["g-admins"],
  });
  // The key sign-in holds matches the certificate on the app, valid a year.
  const cert = new crypto.X509Certificate(clientKey!.certificate!);
  assert.equal(cert.raw.toString("base64"), app.keyCredentials[0]!.key);
  assert.ok(cert.checkPrivateKey(crypto.createPrivateKey(clientKey!.privateKey)));
  assert.equal(Math.round((Date.parse(cert.validTo) - START) / DAY_MS), 365);
  assert.match(app.keyCredentials[0]!.displayName, new RegExp(thumbprintOf(clientKey!.certificate!)));
  assert.equal(s.signIn.state.hasKey, true);
  assert.equal(s.signIn.state.hasSecret, false);

  const owned = s.registry.owned("cn_e").get(SIGNIN_KEY, OWNED_KIND)!;
  assert.equal(owned.externalId, app.id);
  assert.doesNotMatch(JSON.stringify(owned), /PRIVATE KEY/);

  assert.equal(res.body.wired, true);
  assert.equal(res.body.tenantId, TENANT);
  assert.equal(res.body.app?.appId, app.appId);
  assert.equal(res.body.app?.state, "in-sync");
  assert.equal(res.body.app?.credential, "certificate");
  assert.equal(res.body.app?.certificateExpiresAt, new Date(Date.parse(cert.validTo)).toISOString());
  assert.equal(res.body.app?.secretExpiresAt, undefined);
  assert.equal(res.body.consentUrl, `${s.graph.endpoints.login}/${TENANT}/adminconsent?client_id=${MGMT_CLIENT}`);

  const audit = s.m.audit.find((a) => a.action === "connector-entra.signin")!;
  assert.equal(audit.target, app.appId);
  assert.match(audit.detail ?? "", /created app registration; certificate credential/);
  const everything = JSON.stringify([res.body, s.m.audit]);
  assert.doesNotMatch(everything, /PRIVATE KEY/);
  assert.doesNotMatch(everything, new RegExp(MGMT_SECRET));
});

test("running it again reuses the app; the replaced certificate goes at the next sync", async () => {
  const s = await setup();
  await s.call("POST", "/signin", {});
  const app = [...s.graph.apps.values()][0]!;
  const first = app.keyCredentials[0]!.key;
  app.web.redirectUris = ["https://old.example.test/auth/oidc/callback"];

  const res = await s.call<EntraSignInView>("POST", "/signin", { label: "Company sign-in" });
  assert.equal(res.status, 200, res.body.error);
  assert.equal(s.graph.apps.size, 1);
  assert.deepEqual(app.web.redirectUris, [REDIRECT]);
  // Both, so sign-in never waits on Entra's replication of the new one.
  assert.deepEqual(app.keyCredentials[0]!.key, first);
  assert.equal(app.keyCredentials.length, 2);
  assert.equal(s.signIn.writes[1]!.client.label, "Company sign-in");
  assert.equal(
    new crypto.X509Certificate(s.signIn.key!.certificate!).raw.toString("base64"),
    app.keyCredentials[1]!.key
  );
  assert.equal(s.signIn.writes[1]!.client.adminGroups, undefined);
  assert.match(s.m.audit.at(-1)!.detail ?? "", /reused/);

  const report = await s.registry.reconcile("cn_e");
  assert.equal(app.keyCredentials.length, 1);
  assert.notEqual(app.keyCredentials[0]!.key, first);
  assert.equal(report?.items.find((i) => i.key === SIGNIN_KEY)?.state, "in-sync");
});

test("a tenant that refuses certificates gets a client secret instead", async () => {
  const s = await setup({ refuseKeys: true });
  const res = await s.call<EntraSignInView>("POST", "/signin", {});
  assert.equal(res.status, 200, res.body.error);
  const app = [...s.graph.apps.values()][0]!;
  assert.equal(app.keyCredentials.length, 0);
  assert.equal(app.passwordCredentials.length, 1);
  const days = (Date.parse(app.passwordCredentials[0]!.endDateTime) - START) / DAY_MS;
  assert.equal(days, 365);
  assert.equal(s.signIn.secret, app.passwordCredentials[0]!.secretText);
  assert.equal(s.signIn.key, undefined);
  assert.equal(res.body.app?.credential, "secret");
  assert.ok(res.body.app?.secretExpiresAt);
  assert.doesNotMatch(JSON.stringify([res.body, s.m.audit]), new RegExp(app.passwordCredentials[0]!.secretText));

  // Once the tenant takes certificates, the next sync moves sign-in to one
  // and the secret goes the sync after.
  s.graph.refuseKeys = false;
  const report = await s.registry.reconcile("cn_e");
  const item = report!.items.find((i) => i.key === SIGNIN_KEY)!;
  assert.deepEqual(item.diff, [{ path: "credential", want: "certificate", have: "client secret" }]);
  assert.equal(app.keyCredentials.length, 1);
  assert.ok(s.signIn.key);
  assert.equal(s.signIn.writes.at(-1)!.actor, "connector-entra");
  assert.equal(app.passwordCredentials.length, 1);
  await s.registry.reconcile("cn_e");
  assert.equal(app.passwordCredentials.length, 0);
  assert.equal((await s.call<EntraSignInView>("GET", "/view")).body.app?.credential, "certificate");
});

test("sign-in setup needs a connector, an admin and a usable sign-in store", async () => {
  const none = await setup({ connector: false });
  const missing = await none.call<EntraSignInView>("POST", "/signin", {});
  assert.equal(missing.status, 409);
  assert.match(missing.body.error ?? "", /Add the Microsoft Entra ID connector first/);
  const view = await none.call<EntraSignInView>("GET", "/view");
  assert.deepEqual(view.body, { redirectUri: REDIRECT, wired: false });

  const s = await setup();
  s.m.setUser(mockViewer);
  assert.equal((await s.call("POST", "/signin", {})).status, 403);
  assert.equal((await s.call("GET", "/groups")).status, 403);
  assert.equal((await s.call("GET", "/view")).status, 200);
  s.m.setUser(null);

  const locked = await setup();
  locked.signIn.state.blocked = "SECRETS_KEY is not set, so the client secret cannot be stored.";
  const res = await locked.call<EntraSignInView>("POST", "/signin", {});
  assert.equal(res.status, 409);
  assert.equal(locked.graph.apps.size, 0);

  const bad = await setup();
  assert.equal((await bad.call("POST", "/signin", { adminGroups: "g-admins" })).status, 400);

  const refused = await setup();
  refused.graph.roles = [];
  const denied = await refused.call<EntraSignInView>("POST", "/signin", {});
  assert.equal(denied.status, 502);
  assert.match(denied.body.error ?? "", /Insufficient privileges/);
});

test("reconcile does nothing until sign-in is set up", async () => {
  const s = await setup();
  const report = await s.registry.reconcile("cn_e");
  assert.deepEqual(report?.items, []);
  assert.equal(s.graph.apps.size, 0);
});

test("reconcile puts a changed redirect URI and groups claim back", async () => {
  const s = await setup();
  await s.call("POST", "/signin", {});
  const app = [...s.graph.apps.values()][0]!;
  app.web.redirectUris.push("https://evil.example.test/cb");
  app.groupMembershipClaims = "None";

  const view = await s.call<EntraSignInView>("GET", "/view");
  assert.equal(view.body.app?.state, "drifted");

  const report = await s.registry.reconcile("cn_e");
  const item = report!.items.find((i) => i.key === SIGNIN_KEY)!;
  assert.equal(item.state, "drifted");
  assert.deepEqual(
    item.diff?.map((d) => d.path),
    ["web.redirectUris", "groupMembershipClaims"]
  );
  assert.deepEqual(app.web.redirectUris, [REDIRECT]);
  assert.equal(app.groupMembershipClaims, "SecurityGroup");
  assert.equal(s.signIn.writes.length, 1);

  // A new public URL moves the redirect URI with it.
  s.signIn.state.redirectUri = "https://new.example.test/auth/oidc/callback";
  await s.registry.reconcile("cn_e");
  assert.deepEqual(app.web.redirectUris, ["https://new.example.test/auth/oidc/callback"]);

  // An http one is not applied: the last good one stays.
  s.signIn.state.redirectUri = "http://10.0.0.5/auth/oidc/callback";
  const again = await s.registry.reconcile("cn_e");
  assert.equal(again?.items.find((i) => i.key === SIGNIN_KEY)?.state, "in-sync");
  assert.deepEqual(app.web.redirectUris, ["https://new.example.test/auth/oidc/callback"]);
  assert.match((await s.call<EntraSignInView>("GET", "/view")).body.warning ?? "", /refuses http/);
});

test("the certificate is replaced 30 days before it expires and sign-in follows", async () => {
  const s = await setup();
  await s.call("POST", "/signin", {});
  const app = [...s.graph.apps.values()][0]!;
  const original = app.keyCredentials[0]!;

  s.clock.now = START + 300 * DAY_MS;
  assert.equal((await s.registry.reconcile("cn_e"))?.items.find((i) => i.key === SIGNIN_KEY)?.state, "in-sync");
  const okHealth = await kindOf(s).health!(instance(), signal());
  assert.equal(byId(okHealth, "secret")!.status, "ok");
  assert.match(byId(okHealth, "secret")!.detail, /^Certificate, valid until 2027-10-08/);

  s.clock.now = START + 340 * DAY_MS;
  const warn = await kindOf(s).health!(instance(), signal());
  assert.equal(byId(warn, "secret")!.status, "warn");
  assert.match(byId(warn, "secret")!.detail, /The certificate expires 2027-10-08; the next sync replaces it/);

  const report = await s.registry.reconcile("cn_e");
  const item = report!.items.find((i) => i.key === SIGNIN_KEY)!;
  assert.equal(item.state, "drifted");
  assert.equal(item.diff?.[0]?.path, "certificate");
  assert.equal(app.keyCredentials.length, 2);
  const fresh = app.keyCredentials[1]!;
  assert.equal(new crypto.X509Certificate(s.signIn.key!.certificate!).raw.toString("base64"), fresh.key);
  assert.equal(s.signIn.writes.at(-1)!.actor, "connector-entra");
  assert.equal(s.signIn.writes.at(-1)!.client.label, undefined);

  await s.registry.reconcile("cn_e");
  assert.deepEqual(
    app.keyCredentials.map((k) => k.key),
    [fresh.key]
  );
  assert.notEqual(fresh.key, original.key);
  assert.equal(byId(await kindOf(s).health!(instance(), signal()), "secret")!.status, "ok");
});

test("a certificate deleted in the portal is replaced at once", async () => {
  const s = await setup();
  await s.call("POST", "/signin", {});
  const app = [...s.graph.apps.values()][0]!;
  app.keyCredentials = [];
  assert.equal((await s.call<EntraSignInView>("GET", "/view")).body.app?.state, "drifted");
  const report = await s.registry.reconcile("cn_e");
  assert.equal(report?.items.find((i) => i.key === SIGNIN_KEY)?.diff?.[0]?.have, "removed outside this install");
  assert.equal(app.keyCredentials.length, 1);
  assert.equal(
    new crypto.X509Certificate(s.signIn.key!.certificate!).raw.toString("base64"),
    app.keyCredentials[0]!.key
  );
  assert.equal(specOf(s.registry.owned("cn_e"))!.spec.previousCert, undefined);
});

test("the client secret is rotated 30 days before it expires and sign-in follows", async () => {
  const s = await setup({ refuseKeys: true });
  await s.call("POST", "/signin", {});
  const app = [...s.graph.apps.values()][0]!;
  const original = app.passwordCredentials[0]!;

  s.clock.now = START + 300 * DAY_MS;
  assert.equal((await s.registry.reconcile("cn_e"))?.items.find((i) => i.key === SIGNIN_KEY)?.state, "in-sync");
  const okHealth = await kindOf(s).health!(instance(), signal());
  assert.equal(byId(okHealth, "secret")!.status, "ok");

  s.clock.now = START + 340 * DAY_MS;
  const warn = await kindOf(s).health!(instance(), signal());
  assert.equal(byId(warn, "secret")!.status, "warn");
  assert.match(byId(warn, "secret")!.detail, /The client secret expires 2027-10-08; the next sync replaces it/);

  const report = await s.registry.reconcile("cn_e");
  const item = report!.items.find((i) => i.key === SIGNIN_KEY)!;
  assert.equal(item.state, "drifted");
  assert.equal(item.diff?.[0]?.path, "secret");
  assert.equal(app.passwordCredentials.length, 2);
  const fresh = app.passwordCredentials[1]!;
  assert.equal(s.signIn.secret, fresh.secretText);
  assert.equal(s.signIn.writes.at(-1)!.actor, "connector-entra");
  assert.equal(s.signIn.writes.at(-1)!.client.clientId, app.appId);
  assert.equal(s.signIn.writes.at(-1)!.client.label, undefined);
  assert.equal(s.signIn.state.enabled, true);

  // The old one stays until the next sync, so sign-in never waits on Entra's replication.
  assert.ok(app.passwordCredentials.some((p) => p.keyId === original.keyId));
  await s.registry.reconcile("cn_e");
  assert.deepEqual(
    app.passwordCredentials.map((p) => p.keyId),
    [fresh.keyId]
  );
  assert.equal(byId(await kindOf(s).health!(instance(), signal()), "secret")!.status, "ok");
});

test("an expired secret on a wired app is crit until rotated; another client's app is left alone", async () => {
  const s = await setup({ refuseKeys: true });
  await s.call("POST", "/signin", {});
  s.clock.now = START + 400 * DAY_MS;
  const crit = byId(await kindOf(s).health!(instance(), signal()), "secret")!;
  assert.equal(crit.status, "crit");
  assert.match(crit.detail, /client secret expired/);

  // Sign-in moved to another provider: nothing to rotate for.
  s.signIn.state.clientId = "someone-else";
  const writes = s.signIn.writes.length;
  const app = [...s.graph.apps.values()][0]!;
  await s.registry.reconcile("cn_e");
  assert.equal(app.passwordCredentials.length, 1);
  assert.equal(s.signIn.writes.length, writes);
  assert.match(byId(await kindOf(s).health!(instance(), signal()), "secret")!.detail, /Sign-in uses another client/);
});

test("a secret deleted in the portal is replaced at once", async () => {
  const s = await setup({ refuseKeys: true });
  await s.call("POST", "/signin", {});
  const app = [...s.graph.apps.values()][0]!;
  app.passwordCredentials = [];
  const report = await s.registry.reconcile("cn_e");
  assert.equal(report?.items.find((i) => i.key === SIGNIN_KEY)?.diff?.[0]?.have, "removed outside this install");
  assert.equal(app.passwordCredentials.length, 1);
  assert.equal(s.signIn.secret, app.passwordCredentials[0]!.secretText);
  assert.equal(specOf(s.registry.owned("cn_e"))!.spec.previousKeyId, undefined);
});

test("an app deleted in the portal is recreated and sign-in moved to it", async () => {
  const s = await setup();
  await s.call("POST", "/signin", {});
  const gone = [...s.graph.apps.values()][0]!;
  s.graph.apps.clear();
  assert.equal((await s.call<EntraSignInView>("GET", "/view")).body.app?.state, "missing");

  const report = await s.registry.reconcile("cn_e");
  const item = report!.items.find((i) => i.key === SIGNIN_KEY)!;
  assert.equal(item.state, "missing");
  const fresh = [...s.graph.apps.values()][0]!;
  assert.notEqual(fresh.appId, gone.appId);
  assert.deepEqual(fresh.web.redirectUris, [REDIRECT]);
  assert.equal(s.signIn.state.clientId, fresh.appId);
  assert.equal(
    new crypto.X509Certificate(s.signIn.key!.certificate!).raw.toString("base64"),
    fresh.keyCredentials[0]!.key
  );
  assert.equal(specOf(s.registry.owned("cn_e"))!.externalId, fresh.id);
});

test("reconcile throws when Graph is down, so the framework records it", async () => {
  const s = await setup();
  await s.call("POST", "/signin", {});
  s.graph.failWith = 503;
  await assert.rejects(s.registry.reconcile("cn_e"), /answered 503: Try again later/);
  const view = await s.call<EntraSignInView>("GET", "/view");
  assert.equal(view.status, 200);
  assert.match(view.body.warning ?? "", /Entra could not be read/);
});

test("cleanup deletes the app registration it created", async () => {
  const s = await setup();
  await s.call("POST", "/signin", {});
  const owned = s.registry.owned("cn_e");
  const result = await kindOf(s).cleanup!(instance(), owned);
  assert.deepEqual(result, { removed: 1, errors: [] });
  assert.equal(s.graph.apps.size, 0);
  assert.equal(owned.list().length, 0);

  const again = await setup();
  await again.call("POST", "/signin", {});
  again.graph.failWith = 500;
  const failed = await kindOf(again).cleanup!(instance(), again.registry.owned("cn_e"));
  assert.equal(failed.removed, 0);
  assert.match(failed.errors[0] ?? "", /App registration .*answered 500/);
});

test("groups lists security groups by name prefix", async () => {
  const s = await setup();
  const all = await s.call<EntraGroup[]>("GET", "/groups");
  assert.deepEqual(
    all.body.map((g) => g.id),
    ["g-admins", "g-ops", "g-sales"]
  );
  const some = await s.call<EntraGroup[]>("GET", `/groups?search=${encodeURIComponent("cluster")}`);
  assert.deepEqual(some.body, [
    { id: "g-admins", displayName: "Cluster admins" },
    { id: "g-ops", displayName: "Cluster operators" },
  ]);
  assert.match(s.graph.requests.at(-1)!.path, /\$top=50/);

  await s.call("GET", `/groups?search=${encodeURIComponent("o'brien")}`);
  assert.match(s.graph.requests.at(-1)!.path, /startswith\(displayName,'o''brien'\)/);

  const fresh = await setup();
  fresh.graph.roles = ["Application.ReadWrite.OwnedBy"];
  const denied = await fresh.call<EntraGroup[]>("GET", "/groups");
  assert.equal(denied.status, 502);
  assert.match(denied.body.error ?? "", /Insufficient privileges/);
});

test("entraMail sends as a mailbox in the app's scope and reports Graph's refusal", async () => {
  const s = await setup();
  const mail = s.m.ctx.services.get("entraMail");
  assert.deepEqual(await mail.status(), { ready: true, tenantId: TENANT });
  s.graph.mailboxes = ["alerts@example.com"];
  const message = { to: ["ops@example.com"], subject: "[CRIT] x", text: "x", html: "<p>x</p>" };
  await mail.sendMail("alerts@example.com", message);
  assert.equal(s.graph.mail.length, 1);
  assert.deepEqual(s.graph.mail[0]!.body, {
    message: {
      subject: "[CRIT] x",
      body: { contentType: "HTML", content: "<p>x</p>" },
      toRecipients: [{ emailAddress: { address: "ops@example.com" } }],
    },
    saveToSentItems: false,
  });
  await assert.rejects(mail.sendMail("ceo@example.com", message), (err: Error & { status?: number }) => {
    assert.equal(err.status, 403);
    assert.match(err.message, /Access is denied/);
    return true;
  });

  const none = await setup({ connector: false });
  const status = await none.m.ctx.services.get("entraMail").status();
  assert.equal(status.ready, false);
  assert.match(status.reason ?? "", /Entra ID connector/);
});

const currentInstance = async (s: Setup) => (await s.registry.instance("cn_e"))!;

test("with OwnedBy only, the admin uploads the console's certificate once and the secret is retired", async () => {
  const s = await setup();
  const mgmt = s.graph.management;
  await s.registry.reconcile("cn_e");
  let view = (await s.call<EntraSignInView>("GET", "/view")).body;
  assert.deepEqual(view.management, { credential: "secret", secretStored: true, step: UPLOAD_STEP });
  const pending = byId(await kindOf(s).health!(await currentInstance(s), signal()), "management")!;
  assert.equal(pending.status, "warn");
  assert.equal(pending.deepLink, "api/connector-entra/certificate");

  const pem = await s.call<string>("GET", "/certificate");
  assert.equal(pem.status, 200);
  assert.match(pem.body, /^-----BEGIN CERTIFICATE-----/);
  assert.doesNotMatch(pem.body, /PRIVATE/);
  assert.equal((await s.call<string>("GET", "/certificate")).body, pem.body);
  s.m.setUser(mockViewer);
  assert.equal((await s.call("GET", "/certificate")).status, 403);
  s.m.setUser(mockAdmin);

  // The admin uploads it in the portal.
  mgmt.keyCredentials.push({
    keyId: "k-admin",
    displayName: "uploaded by hand",
    key: new crypto.X509Certificate(pem.body).raw.toString("base64"),
  });
  const switched = await s.registry.reconcile("cn_e");
  assert.deepEqual(switched?.items.find((i) => i.key === "management")?.diff, [
    { path: "credential", want: "certificate", have: "secret" },
  ]);
  view = (await s.call<EntraSignInView>("GET", "/view")).body;
  assert.equal(view.management?.credential, "certificate");
  assert.equal(view.management?.step, DELETE_SECRET_STEP);
  assert.equal(view.management?.secretStored, true);
  assert.ok(view.management?.certificateExpiresAt);

  // The admin deletes the secret: the console forgets it too.
  mgmt.passwordCredentials = [];
  await s.registry.reconcile("cn_e");
  assert.equal((await currentInstance(s)).secrets.clientSecret, undefined);
  view = (await s.call<EntraSignInView>("GET", "/view")).body;
  assert.deepEqual(
    { ...view.management, certificateExpiresAt: undefined },
    { credential: "certificate", secretStored: false, certificateExpiresAt: undefined }
  );
  assert.equal(byId(await kindOf(s).health!(await currentInstance(s), signal()), "management")!.status, "ok");

  // An edit form tested without a secret signs in with the certificate.
  const checks = await kindOf(s).verify({ tenantId: TENANT, clientId: MGMT_CLIENT }, signal());
  assert.equal(byId(checks, "graph")!.status, "ok");
  assert.match(byId(checks, "graph")!.detail, /with its certificate/);

  // Sign-in setup and mail run on it.
  const before = s.graph.tokenCredentials.length;
  assert.equal((await s.call<EntraSignInView>("POST", "/signin", {})).status, 200);
  s.graph.mailboxes = ["alerts@example.com"];
  const mail = s.m.ctx.services.get("entraMail");
  assert.deepEqual(await mail.status(), { ready: true, tenantId: TENANT });
  await mail.sendMail("alerts@example.com", { to: ["ops@example.com"], subject: "s", text: "t", html: "<p>t</p>" });
  assert.equal(s.graph.mail.length, 1);
  assert.ok(s.graph.tokenCredentials.slice(before).every((c) => c === "certificate"));
});

test("when the management app may write itself, the console uploads its certificate and deletes the secret", async () => {
  const s = await setup();
  const mgmt = s.graph.management;
  mgmt.selfAccess = true;
  const first = await s.registry.reconcile("cn_e");
  assert.equal(mgmt.keyCredentials.length, 1);
  assert.equal(first?.items.find((i) => i.key === "management")?.diff?.[0]?.path, "keyCredentials");
  assert.equal(mgmt.passwordCredentials.length, 1);

  const second = await s.registry.reconcile("cn_e");
  assert.deepEqual(
    second?.items.filter((i) => i.key === "management").flatMap((i) => i.diff?.map((d) => d.path)),
    ["credential", "clientSecret"]
  );
  assert.equal(mgmt.passwordCredentials.length, 0);
  assert.equal((await currentInstance(s)).secrets.clientSecret, undefined);
  const view = (await s.call<EntraSignInView>("GET", "/view")).body;
  assert.equal(view.management?.credential, "certificate");
  assert.equal(view.management?.step, undefined);
  assert.equal(view.management?.secretStored, false);
});

test("a secret that matches more than one of the app's secrets is left for the admin to delete", async () => {
  const s = await setup();
  const mgmt = s.graph.management;
  mgmt.selfAccess = true;
  mgmt.passwordCredentials.push({
    keyId: "other",
    displayName: "someone else's",
    endDateTime: "2028-01-01T00:00:00Z",
    secretText: `${MGMT_SECRET.slice(0, 3)}-different`,
  });
  await s.registry.reconcile("cn_e");
  await s.registry.reconcile("cn_e");
  assert.equal(mgmt.passwordCredentials.length, 2);
  assert.equal((await s.call<EntraSignInView>("GET", "/view")).body.management?.step, DELETE_SECRET_STEP);
});

test("the management certificate is rolled with addKey before it expires, and the old one removed", async () => {
  const s = await setup();
  const mgmt = s.graph.management;
  mgmt.selfAccess = true;
  await s.registry.reconcile("cn_e");
  await s.registry.reconcile("cn_e");
  const original = mgmt.keyCredentials[0]!.key;

  // Plain OwnedBy and no object id: the console can't name itself in a proof.
  mgmt.selfAccess = false;
  s.clock.now = START + 340 * DAY_MS;
  await s.registry.reconcile("cn_e");
  assert.equal(mgmt.keyCredentials.length, 1);
  assert.match(
    (await s.call<EntraSignInView>("GET", "/view")).body.management?.step ?? "",
    /Add the management app's Object ID/
  );

  s.registry.addInstance({ ...(await currentInstance(s)), config: { ...instance().config, objectId: mgmt.id } });
  const rolled = await s.registry.reconcile("cn_e");
  assert.equal(rolled?.items.find((i) => i.key === "management")?.diff?.[0]?.path, "certificate");
  assert.equal(mgmt.keyCredentials.length, 2);
  // Graph still answers on either while Entra replicates.
  assert.equal((await s.call("GET", "/groups")).status, 200);

  await s.registry.reconcile("cn_e");
  assert.equal(mgmt.keyCredentials.length, 1);
  assert.notEqual(mgmt.keyCredentials[0]!.key, original);
  const view = (await s.call<EntraSignInView>("GET", "/view")).body;
  assert.equal(view.management?.credential, "certificate");
  assert.equal(view.management?.step, undefined);
  assert.equal(Math.round((Date.parse(view.management!.certificateExpiresAt!) - s.clock.now) / DAY_MS), 365);
});

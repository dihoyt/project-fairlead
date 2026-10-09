import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { RESOURCES } from "../../../src/contracts/k8s.js";
import type { InstallSeed, InstallSeedView } from "../../../src/contracts/onboarding.js";
import type { ConnectorView } from "../../../src/contracts/connectors.js";
import { apiMocks } from "../../../src/contracts/mocks/api.js";
import { createMockContext, type MockCalls, type MockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { mockSeedEnv, mockSeedSecret } from "../../../src/contracts/mocks/seed.js";
import { createMockSignIn } from "../../../src/contracts/mocks/signin.js";
import { product } from "../../../src/product.js";
import { HttpError } from "../../../src/runtime/http.js";
import onboarding from "../../../src/modules/onboarding/index.js";
import { createSeedStore, importSeed, SEED_SCOPE } from "../../../src/modules/onboarding/seed.js";
import { parseSeed } from "../../../src/modules/onboarding/seedParse.js";
import { listen } from "../../runtime/helpers.js";

const NS = "console-ns";
let open: Array<{ m: MockContext; close?: () => Promise<void> }> = [];

afterEach(async () => {
  for (const { m, close } of open) {
    await close?.();
    await m.close();
  }
  open = [];
});

const SECRET_VALUES = (
  ["ADMIN_PASSWORD", "CLOUDFLARE_API_TOKEN", "STORAGE_SECRET", "SMTP_PASSWORD", "AUTHENTIK_BOOTSTRAP_PASSWORD"] as const
).map((key) => mockSeedEnv[key]!);
const leaks = (text: string) => SECRET_VALUES.filter((value) => text.includes(value));

function context(options: { calls?: MockCalls; signedIn?: boolean } = {}) {
  const signin = createMockSignIn();
  signin.adminSignedIn = options.signedIn ?? false;
  const k8s = createFakeK8s({ objects: [{ ref: RESOURCES.secrets, items: [mockSeedSecret(NS)] }] });
  const m = createMockContext("onboarding", {
    migrations: onboarding.migrations,
    services: { signin },
    calls: options.calls,
  });
  open.push({ m });
  return { m, k8s, signin, store: createSeedStore(m.ctx) };
}

test("the env file parses into groups; ones missing a key become problems, never values", () => {
  const { seed, problems } = parseSeed(mockSeedEnv);
  assert.deepEqual(problems, {});
  assert.equal(seed.adminPassword, mockSeedEnv.ADMIN_PASSWORD);
  assert.deepEqual(seed.cloudflare, { token: "cf-token-example", zone: "example.com", accessApps: "per-app" });
  assert.equal(seed.storageTarget?.protocol, "smb");
  assert.deepEqual(seed.smtp?.to, ["ops@example.com", "oncall@example.com"]);
  assert.deepEqual(seed.bundle, {
    include: ["longhorn"],
    access: "cloudflare-tunnel",
    baseDomain: "example.com",
    adminEmail: "admin@example.com",
  });

  const broken = parseSeed({
    CLOUDFLARE_API_TOKEN: "t0ken-value",
    STORAGE_URL: "s3://bucket@us-east-1/",
    SMTP_PRESET: "google-oauth",
    SMTP_TO: "a@example.com",
    BUNDLE: "default",
    OIDC_ISSUER: "https://id.example.com",
  });
  assert.match(broken.problems.cloudflare!, /CLOUDFLARE_ZONE is missing/);
  assert.match(broken.problems["storage-target"]!, /access key pair/);
  assert.match(broken.problems.email!, /need a browser/);
  assert.match(broken.problems.bundle!, /BASE_DOMAIN/);
  assert.match(broken.problems.oidc!, /OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are missing/);
  assert.deepEqual(leaks(JSON.stringify(broken.problems)), []);
  assert.doesNotMatch(JSON.stringify(broken.problems), /t0ken-value/);
});

test("boot: sets the admin password and public URL, seals the rest, deletes the Secret", async () => {
  const { m, k8s, signin, store } = context();
  assert.equal(await importSeed(m.ctx, store, k8s, signin, NS), "imported");

  assert.equal(signin.adminPassword, mockSeedEnv.ADMIN_PASSWORD);
  assert.equal(signin.publicUrl, "https://console.example.com");
  assert.deepEqual(
    k8s.writes.map((w) => [w.verb, w.name, w.namespace]),
    [["delete", "install-seed", NS]]
  );

  const items = JSON.parse(store.row()!.items) as InstallSeedView["items"];
  assert.deepEqual(
    items.map((i) => [i.id, i.state]),
    [
      ["admin-password", "applied"],
      ["public-url", "applied"],
      ["cloudflare", "pending"],
      ["storage-target", "pending"],
      ["email", "pending"],
      ["bundle", "pending"],
    ]
  );

  const sealed = JSON.parse((await m.ctx.secrets.get(SEED_SCOPE, "values"))!) as InstallSeed;
  assert.equal(sealed.adminPassword, undefined);
  assert.equal(sealed.publicUrl, undefined);
  assert.equal(sealed.authentikBootstrapPassword, mockSeedEnv.AUTHENTIK_BOOTSTRAP_PASSWORD);
  assert.equal(sealed.cloudflare?.token, "cf-token-example");

  assert.ok(m.audit.some((entry) => entry.action === "onboarding.seed-import"));
  assert.deepEqual(leaks(JSON.stringify(m.audit) + store.row()!.items), []);

  // The Secret is gone, so the next look has nothing to do.
  assert.equal(await importSeed(m.ctx, store, k8s, signin, NS), "absent");
});

test("boot: an admin who already signed in keeps their password", async () => {
  const { m, k8s, signin, store } = context({ signedIn: true });
  await importSeed(m.ctx, store, k8s, signin, NS);
  const first = (JSON.parse(store.row()!.items) as InstallSeedView["items"])[0]!;
  assert.equal(first.state, "skipped");
  assert.equal(signin.adminPassword, undefined);
});

test("boot: the bundle's app password falls back to ADMIN_PASSWORD", async () => {
  const { m, signin, store } = context();
  const env = { ...mockSeedEnv };
  delete env.AUTHENTIK_BOOTSTRAP_PASSWORD;
  const k8s = createFakeK8s({ objects: [{ ref: RESOURCES.secrets, items: [mockSeedSecret(NS, env)] }] });
  await importSeed(m.ctx, store, k8s, signin, NS);
  const sealed = JSON.parse((await m.ctx.secrets.get(SEED_SCOPE, "values"))!) as InstallSeed;
  assert.equal(sealed.authentikBootstrapPassword, mockSeedEnv.ADMIN_PASSWORD);
});

test("boot: a Secret that is still there after an import is only deleted again", async () => {
  const { m, signin, store } = context();
  const k8s = createFakeK8s({ objects: [{ ref: RESOURCES.secrets, items: [mockSeedSecret(NS)] }] });
  await importSeed(m.ctx, store, k8s, signin, NS);
  const again = createFakeK8s({ objects: [{ ref: RESOURCES.secrets, items: [mockSeedSecret(NS)] }] });
  signin.adminPassword = undefined;
  assert.equal(await importSeed(m.ctx, store, again, signin, NS), "kept");
  assert.equal(signin.adminPassword, undefined);
  assert.equal(again.writes.length, 1);
});

const connector = (kind: string, checks: ConnectorView["checks"] = []): ConnectorView => ({
  ...structuredClone(apiMocks["POST /api/connectors"]),
  id: `${kind}-1`,
  kind,
  checks,
});

async function applied(calls: MockCalls) {
  const { m, k8s, signin, store } = context({ calls });
  await importSeed(m.ctx, store, k8s, signin, NS);
  await onboarding.register(m.ctx);
  const server = await listen(m.app);
  open.push({ m, close: server.close });
  const post = async (path: string) => {
    const res = await fetch(`${server.url}/api/onboarding/seed${path}`, { method: "POST" });
    return { status: res.status, json: (await res.json()) as InstallSeedView & { error?: string } };
  };
  return { m, post, server };
}

const happy: MockCalls = {
  "GET /api/connectors": () => [],
  "POST /api/connector-cloudflare/discover": () => ({
    tokenStatus: "active",
    accounts: [
      { id: "acc-1", name: "One" },
      { id: "acc-2", name: "Two" },
    ],
    zones: [{ id: "z", name: "example.com", accountId: "acc-2" }],
    tunnels: [],
  }),
  "POST /api/connectors": (input) => connector(input.body!.kind),
  "GET /api/connector-cloudflare/view": () => ({
    accessPolicy: "never",
    hosts: [],
    existingTunnels: [{ id: "old-tunnel", name: product.slug, status: "inactive" }],
  }),
  "POST /api/connectors/:id/test": (input) => connector(input.params!.id, []),
  "POST /api/notify/channels/:id/test": () => ({ ok: true }),
};

test("apply: creates each item as the admin, in order, and drops the sealed copy", async () => {
  const { m, post } = await applied(happy);
  const { status, json } = await post("/apply");
  assert.equal(status, 200);
  assert.equal(json.state, "done");
  assert.equal(json.appliedBy, "admin");
  assert.deepEqual(
    json.items.map((i) => [i.id, i.state]),
    [
      ["admin-password", "applied"],
      ["public-url", "applied"],
      ["cloudflare", "applied"],
      ["storage-target", "applied"],
      ["email", "applied"],
      ["bundle", "applied"],
    ]
  );

  const keys = m.calls.map((c) => c.key);
  assert.deepEqual(keys.slice(0, 8), [
    "GET /api/connectors",
    "POST /api/connector-cloudflare/discover",
    "POST /api/connectors",
    "PUT /api/admin/settings/:key",
    "GET /api/connector-cloudflare/view",
    "POST /api/connector-cloudflare/tunnel",
    "POST /api/connector-cloudflare/tunnel/deploy",
    "POST /api/connector-cloudflare/sync",
  ]);
  assert.ok(m.calls.every((c) => c.user.id === "admin"));
  const body = (key: string, n = 0) => m.calls.filter((c) => c.key === key)[n]!.input.body as Record<string, unknown>;
  assert.deepEqual(body("POST /api/connectors"), {
    kind: "cloudflare",
    name: "Cloudflare",
    values: { apiToken: "cf-token-example", accountId: "acc-2", zone: "example.com" },
  });
  assert.deepEqual(body("POST /api/connector-cloudflare/tunnel"), { tunnelId: "old-tunnel" });
  const storage = body("POST /api/connectors", 1);
  assert.equal((storage.values as Record<string, string>).username, "backup");
  assert.equal((storage.values as Record<string, string>).password, "smb-password-example");
  assert.equal((storage.values as Record<string, string>).accessKeyId, "");
  const channel = body("POST /api/notify/channels");
  assert.equal(channel.secret, "app-password-example");
  const bundle = body("POST /api/deploy/bundles");
  assert.deepEqual(bundle.include, ["longhorn"]);
  assert.deepEqual(bundle.inputs, {
    access: "cloudflare-tunnel",
    cloudflareSetup: "api",
    baseDomain: "example.com",
    adminEmail: "admin@example.com",
    adminPassword: "authentik-first-password",
  });

  assert.equal(await m.ctx.secrets.get(SEED_SCOPE, "values"), null);
  assert.deepEqual(leaks(JSON.stringify(json) + JSON.stringify(m.audit)), []);

  // Nothing left to do: a second call makes no calls.
  const before = m.calls.length;
  assert.equal((await post("/apply")).json.state, "done");
  assert.equal(m.calls.length, before);
});

test("apply: a failing item records the route's error and the rest still run", async () => {
  const { post } = await applied({
    ...happy,
    "POST /api/connectors/:id/test": (input) =>
      connector(input.params!.id, [
        {
          id: "reach",
          label: "Reach nas.example.com:445",
          status: "crit",
          detail: "connection refused",
          observedAt: "",
        },
      ]),
    "POST /api/notify/channels": () => {
      throw new HttpError(400, "config.email.from: not an address.");
    },
  });
  const { json } = await post("/apply");
  const byId = Object.fromEntries(json.items.map((i) => [i.id, i]));
  assert.equal(byId["storage-target"]!.state, "failed");
  assert.match(byId["storage-target"]!.detail, /connection refused/);
  assert.equal(byId.email!.state, "failed");
  assert.equal(byId.email!.detail, "config.email.from: not an address.");
  assert.equal(byId.bundle!.state, "applied");
});

test("apply: an existing connector is left alone, and the summary can be dismissed once done", async () => {
  const { post } = await applied({ ...happy, "GET /api/connectors": () => [connector("cloudflare")] });
  assert.equal((await post("/dismiss")).status, 409);
  const { json } = await post("/apply");
  assert.equal(json.items.find((i) => i.id === "cloudflare")!.state, "skipped");
  const dismissed = await post("/dismiss");
  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.json.dismissed, true);
});

test("no seed: the summary says none", async () => {
  const m = createMockContext("onboarding", { migrations: onboarding.migrations });
  await onboarding.register(m.ctx);
  const server = await listen(m.app);
  open.push({ m, close: server.close });
  const res = await fetch(`${server.url}/api/onboarding/seed`);
  assert.deepEqual(await res.json(), { state: "none", items: [], dismissed: false });
});

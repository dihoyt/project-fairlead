// The registry modules use through ctx.settings and ctx.secrets, and the
// audit log behind ctx.audit.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { z } from "zod";
import type { Module } from "../../src/contracts/module.js";
import type { Setting } from "../../src/contracts/platform.js";
import { settingTypeOf } from "../../src/platform/settings.js";
import { boot, type Booted } from "./harness.js";

let app: Booted;
let declared: Record<string, Setting<unknown>> = {};
let moduleSecrets: { put(id: string, v: string): Promise<void>; get(id: string): Promise<string | null> };
let moduleAudit: (action: string) => void;

// A module that declares settings and uses secrets and audit through its
// context, as a real one would.
const hosts: Module = {
  id: "hosts",
  milestone: "A",
  register(ctx) {
    declared = {
      interval: ctx.settings.declare({
        key: "hosts.intervalSeconds",
        label: "Poll interval",
        schema: z.number().int().min(10),
        default: 60,
        env: "HOSTS_INTERVAL",
      }),
      enabled: ctx.settings.declare({
        key: "hosts.enabled",
        label: "Poll hosts",
        schema: z.boolean(),
        default: true,
      }),
      names: ctx.settings.declare({
        key: "hosts.names",
        label: "Names",
        schema: z.array(z.string()),
        default: [] as string[],
        env: "HOSTS_NAMES",
      }),
      mode: ctx.settings.declare({
        key: "hosts.mode",
        label: "Mode",
        schema: z.enum(["ssh", "agent"]),
        default: "ssh" as const,
      }),
      socket: ctx.settings.declare({
        key: "hosts.socket",
        label: "Agent socket",
        help: "Where the agent listens.",
        schema: z.string(),
        default: "/run/agent.sock",
        env: "HOSTS_SOCKET",
        envOnly: true,
      }),
    } as Record<string, Setting<unknown>>;
    moduleSecrets = {
      put: (id, v) => ctx.secrets.put("hosts", id, v),
      get: (id) => ctx.secrets.get("hosts", id),
    };
    moduleAudit = (action) => ctx.audit.record({ actor: "system", action, target: "nas" });
  },
};

let cookie = "";

beforeEach(async () => {
  delete process.env.HOSTS_INTERVAL;
  delete process.env.HOSTS_NAMES;
  delete process.env.HOSTS_SOCKET;
  app = await boot({ modules: [hosts] });
  await app.makeUser("root", "root password!!", { role: "admin" });
  cookie = (await app.login("root", "root password!!")).cookie;
});
afterEach(() => app.close());

const put = (key: string, value: unknown) => app.send("PUT", `/api/admin/settings/${key}`, { value }, cookie);

test("a module's schema decides the form's field type", () => {
  assert.deepEqual(settingTypeOf(z.number()), { type: "number" });
  assert.deepEqual(settingTypeOf(z.boolean().default(true)), { type: "boolean" });
  assert.deepEqual(settingTypeOf(z.array(z.string())), { type: "list" });
  assert.deepEqual(settingTypeOf(z.enum(["a", "b"])), { type: "enum", options: ["a", "b"] });
  assert.deepEqual(settingTypeOf(z.object({ a: z.string() })), { type: "json" });
  assert.deepEqual(settingTypeOf(z.string().optional()), { type: "string" });
});

test("a module setting resolves UI over env over default, read fresh each time", async () => {
  const interval = declared.interval!;
  assert.deepEqual([interval.get(), interval.source()], [60, "default"]);
  process.env.HOSTS_INTERVAL = "120";
  assert.deepEqual([interval.get(), interval.source()], [120, "env"]);
  assert.equal((await put("hosts.intervalSeconds", 300)).status, 200);
  assert.deepEqual([interval.get(), interval.source()], [300, "ui"]);
  assert.equal((await app.send("DELETE", "/api/admin/settings/hosts.intervalSeconds", undefined, cookie)).status, 200);
  assert.deepEqual([interval.get(), interval.source()], [120, "env"]);
});

test("the module's schema validates both the form and the environment", async () => {
  const res = await put("hosts.intervalSeconds", 5);
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /^Poll interval:/);
  assert.equal((await put("hosts.mode", "telnet")).status, 400);
  assert.equal((await put("hosts.mode", "agent")).status, 200);
  assert.equal(declared.mode!.get(), "agent");

  process.env.HOSTS_INTERVAL = "often";
  assert.deepEqual([declared.interval!.get(), declared.interval!.source()], [60, "default"]);
  const overview = (await (await app.get("/api/admin/overview", cookie)).json()) as {
    settings: { key: string; envError?: string; group: string; type: string }[];
  };
  const row = overview.settings.find((s) => s.key === "hosts.intervalSeconds")!;
  assert.equal(row.group, "hosts");
  assert.equal(row.type, "number");
  assert.ok(row.envError);
});

test("lists and booleans read from env strings", () => {
  process.env.HOSTS_NAMES = "nas, pi ,router";
  assert.deepEqual(declared.names!.get(), ["nas", "pi", "router"]);
  process.env.HOSTS_NAMES = '["a","b"]';
  assert.deepEqual(declared.names!.get(), ["a", "b"]);
});

test("an env-only setting is read-only, listed with the environment", async () => {
  process.env.HOSTS_SOCKET = "/tmp/agent.sock";
  assert.equal(declared.socket!.get(), "/tmp/agent.sock");
  assert.equal((await put("hosts.socket", "/elsewhere")).status, 409);
  const overview = (await (await app.get("/api/admin/overview", cookie)).json()) as {
    settings: { key: string }[];
    environment: { name: string; value: string; help: string }[];
  };
  assert.ok(!overview.settings.some((s) => s.key === "hosts.socket"));
  assert.deepEqual(
    overview.environment.find((e) => e.name === "HOSTS_SOCKET"),
    { name: "HOSTS_SOCKET", help: "Where the agent listens.", set: true, value: "/tmp/agent.sock" }
  );
});

test("module secrets are sealed at rest and refused without SECRETS_KEY", async () => {
  await moduleSecrets.put("nas", "ssh-private-key");
  assert.equal(await moduleSecrets.get("nas"), "ssh-private-key");
  const row = app.db.prepare("SELECT ciphertext, org_id FROM secrets WHERE scope = 'hosts' AND id = 'nas'").get() as {
    ciphertext: string;
    org_id: string;
  };
  assert.ok(!row.ciphertext.includes("ssh-private-key"));
  assert.equal(row.org_id, "default");
  const key = process.env.SECRETS_KEY;
  delete process.env.SECRETS_KEY;
  try {
    await assert.rejects(moduleSecrets.put("other", "x"), /SECRETS_KEY/);
    await assert.rejects(moduleSecrets.get("nas"), /SECRETS_KEY/);
  } finally {
    process.env.SECRETS_KEY = key;
  }
  process.env.SECRETS_KEY = "a-different-key-0123456789";
  try {
    await assert.rejects(moduleSecrets.get("nas"), /has changed/);
  } finally {
    process.env.SECRETS_KEY = key;
  }
});

test("a module's audit records are listed for admins", async () => {
  moduleAudit("hosts.create");
  const rows = (await (await app.get("/api/admin/audit", cookie)).json()) as { action: string; username: string }[];
  assert.deepEqual(
    rows.filter((r) => r.action === "hosts.create").map((r) => r.username),
    ["system"]
  );
});

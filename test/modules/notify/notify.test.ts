import { test, mock as nodeMock } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Express } from "express";
import { createMockContext, mockViewer } from "../../../src/contracts/mocks/context.js";
import type { ChannelView, TestSendResult, WebhookPayload } from "../../../src/contracts/notify.js";
import type { Status } from "../../../src/contracts/health.js";
import { silentLogger } from "../../../src/runtime/log.js";
import notify from "../../../src/modules/notify/index.js";
import { createEngine, shouldSend, MAX_ATTEMPTS } from "../../../src/modules/notify/engine.js";

const realFetch = globalThis.fetch;

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

// Stands in for every outbound delivery; loopback requests (the test's own
// API calls) go to the real fetch.
function stubDeliveries(answer: (url: string) => number = () => 200) {
  const sent: Captured[] = [];
  const stub = nodeMock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
    sent.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const status = answer(url);
    return new Response(status < 300 ? "" : "nope", { status });
  });
  return { sent, restore: () => stub.mock.restore() };
}

async function listen(app: Express) {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/notify`;
  return { url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function setup() {
  const m = createMockContext("notify", { migrations: notify.migrations ?? [] });
  await notify.register(m.ctx);
  const server = await listen(m.app);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await realFetch(`${server.url}${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  return {
    m,
    call,
    async close() {
      await server.close();
      await m.close();
    },
  };
}

const DISCORD = "https://discord.com/api/webhooks/123/secret-token";
const HOOK = "https://hooks.example.test/in?token=abc";

async function threeChannels(call: Awaited<ReturnType<typeof setup>>["call"]) {
  const created = [
    await call("POST", "/channels", { kind: "webhook", label: "Hook", secret: HOOK }),
    await call("POST", "/channels", {
      kind: "ntfy",
      label: "Phone",
      config: { server: "https://ntfy.example.test/", topic: "alerts" },
      secret: "tk_ntfy",
    }),
    await call("POST", "/channels", { kind: "discord", label: "Ops", minSeverity: "crit", secret: DISCORD }),
  ];
  for (const c of created) assert.equal(c.status, 200, JSON.stringify(c.body));
  return created.map((c) => c.body as ChannelView);
}

function clockedEngine(m: ReturnType<typeof createMockContext>, timing = { debounceMs: 60_000, maxHoldMs: 600_000 }) {
  let t = Date.parse("2026-10-07T12:00:00Z");
  const engine = createEngine({
    db: m.ctx.db,
    orgId: m.ctx.orgId,
    secrets: m.ctx.secrets,
    log: silentLogger,
    timing: () => timing,
    now: () => t,
  });
  return {
    engine,
    advance(ms: number) {
      t += ms;
    },
  };
}

const change = (from: Status, to: Status, checkId = "pods.crashloop") => ({
  providerId: "cluster",
  checkId,
  label: "Crashlooping pods",
  from,
  to,
  detail: to === "ok" ? "No crashlooping pods" : "web-1 in CrashLoopBackOff",
});

test("channels: create, list without secrets, update, delete, audited", async () => {
  const { m, call, close } = await setup();
  try {
    const [hook, ntfy, discord] = await threeChannels(call);
    assert.equal(hook!.hasSecret, true);
    assert.deepEqual(ntfy!.config, { server: "https://ntfy.example.test", topic: "alerts" });
    assert.equal(discord!.minSeverity, "crit");

    const list = await call("GET", "/channels");
    assert.equal((list.body as ChannelView[]).length, 3);
    assert.ok(!JSON.stringify(list.body).includes("secret-token"));
    assert.ok(!JSON.stringify(list.body).includes("tk_ntfy"));

    const updated = await call("PUT", `/channels/${ntfy!.id}`, {
      kind: "ntfy",
      label: "Pager",
      enabled: false,
      config: { topic: "alerts" },
      secret: "",
    });
    assert.equal(updated.status, 200);
    const view = updated.body as ChannelView;
    assert.equal(view.label, "Pager");
    assert.equal(view.enabled, false);
    assert.equal(view.hasSecret, false);
    assert.equal(view.minSeverity, "warn");

    // Omitted secret keeps the stored one.
    const kept = await call("PUT", `/channels/${discord!.id}`, { kind: "discord", label: "Ops2" });
    assert.equal((kept.body as ChannelView).hasSecret, true);
    assert.equal(m.secrets.get(`notify/${discord!.id}`), DISCORD);

    assert.equal((await call("DELETE", `/channels/${hook!.id}`)).status, 200);
    assert.equal(m.secrets.has(`notify/${hook!.id}`), false);
    assert.equal((await call("DELETE", `/channels/${hook!.id}`)).status, 404);

    assert.deepEqual(
      m.audit.map((a) => a.action),
      ["notify.create", "notify.create", "notify.create", "notify.update", "notify.update", "notify.delete"]
    );
    assert.ok(m.audit.every((a) => !String(a.detail).includes("secret-token")));
  } finally {
    await close();
  }
});

test("channels: invalid requests are refused", async () => {
  const { call, close } = await setup();
  try {
    assert.equal((await call("POST", "/channels", { kind: "discord", label: "x" })).status, 400);
    assert.equal(
      (await call("POST", "/channels", { kind: "discord", label: "x", secret: "http://discord.com/x" })).status,
      400
    );
    assert.equal((await call("POST", "/channels", { kind: "webhook", label: "x", secret: "file:///etc" })).status, 400);
    assert.equal((await call("POST", "/channels", { kind: "ntfy", label: "x" })).status, 400);
    assert.equal(
      (await call("POST", "/channels", { kind: "ntfy", label: "x", config: { topic: "a/../b" } })).status,
      400
    );
    assert.equal((await call("POST", "/channels", { kind: "sms", label: "x" })).status, 400);
    const ok = await call("POST", "/channels", { kind: "webhook", label: "x", secret: HOOK });
    const id = (ok.body as ChannelView).id;
    assert.equal((await call("PUT", `/channels/${id}`, { kind: "ntfy", label: "x" })).status, 400);
    assert.equal((await call("PUT", `/channels/${id}`, { kind: "webhook", label: "x", secret: "" })).status, 400);
    assert.equal((await call("PUT", "/channels/ch_nope", { kind: "webhook", label: "x" })).status, 404);
  } finally {
    await close();
  }
});

test("channels: a viewer can list but not change or test", async () => {
  const { m, call, close } = await setup();
  try {
    const [hook] = await threeChannels(call);
    m.setUser(mockViewer);
    assert.equal((await call("GET", "/channels")).status, 200);
    assert.equal((await call("POST", "/channels", { kind: "webhook", label: "x", secret: HOOK })).status, 403);
    assert.equal((await call("PUT", `/channels/${hook!.id}`, { kind: "webhook", label: "y" })).status, 403);
    assert.equal((await call("DELETE", `/channels/${hook!.id}`)).status, 403);
    assert.equal((await call("POST", `/channels/${hook!.id}/test`)).status, 403);
  } finally {
    await close();
  }
});

test("test-send reaches the channel and reports failures without the secret", async () => {
  const { m, call, close } = await setup();
  const out = stubDeliveries((url) => (url.startsWith("https://discord.com") ? 404 : 200));
  try {
    const [hook, , discord] = await threeChannels(call);
    const good = await call("POST", `/channels/${hook!.id}/test`);
    assert.deepEqual(good.body as TestSendResult, { ok: true, status: 200 });
    assert.equal(out.sent[0]!.url, HOOK);
    assert.equal((out.sent[0]!.body as unknown as WebhookPayload).checkId, "test");

    const bad = (await call("POST", `/channels/${discord!.id}/test`)).body as TestSendResult;
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 404);
    assert.ok(!String(bad.error).includes("secret-token"));

    const list = (await call("GET", "/channels")).body as ChannelView[];
    assert.ok(list.find((c) => c.id === hook!.id)!.lastSentAt);
    assert.match(list.find((c) => c.id === discord!.id)!.lastError!, /HTTP 404/);
    assert.equal((await call("POST", "/channels/ch_nope/test")).status, 404);
    assert.deepEqual(
      m.audit.filter((a) => a.action === "notify.test").map((a) => a.result),
      ["ok", "error"]
    );
  } finally {
    out.restore();
    await close();
  }
});

test("module subscribes to health.changed and schedules its flush", async () => {
  const { m, close } = await setup();
  try {
    m.ctx.bus.emit("health.changed", change("ok", "crit"));
    await new Promise((resolve) => setImmediate(resolve));
    const pending = m.ctx.db.prepare("SELECT check_id, to_status FROM notify_pending").all();
    assert.deepEqual(pending, [{ check_id: "pods.crashloop", to_status: "crit" }]);
    assert.ok(m.ctx.scheduler.list().some((job) => job.name === "notify.flush"));
  } finally {
    await close();
  }
});

test("a state change reaches all three channel types, each in its own format", async () => {
  const { m, call, close } = await setup();
  const out = stubDeliveries();
  try {
    await threeChannels(call);
    const { engine, advance } = clockedEngine(m);
    engine.record(change("ok", "crit"));
    await engine.flush();
    assert.equal(out.sent.length, 0, "held for the debounce window");

    advance(60_000);
    await engine.flush();
    assert.equal(out.sent.length, 3);
    const [hook, ntfy, discord] = out.sent;

    assert.equal(hook!.url, HOOK);
    const payload = hook!.body as unknown as WebhookPayload;
    assert.deepEqual(
      { ...payload, at: undefined, source: undefined },
      { ...change("ok", "crit"), at: undefined, source: undefined }
    );
    assert.ok(payload.source.length > 0);

    assert.equal(ntfy!.url, "https://ntfy.example.test/");
    assert.equal(ntfy!.headers.authorization, "Bearer tk_ntfy");
    assert.equal(ntfy!.body.topic, "alerts");
    assert.equal(ntfy!.body.priority, 5);
    assert.equal(ntfy!.body.title, "[CRIT] Crashlooping pods");

    assert.equal(discord!.url, DISCORD);
    const embed = (discord!.body.embeds as Array<Record<string, unknown>>)[0]!;
    assert.equal(embed.title, "[CRIT] Crashlooping pods");
    assert.deepEqual(discord!.body.allowed_mentions, { parse: [] });

    assert.equal(m.ctx.db.prepare("SELECT count(*) AS n FROM notify_pending").pluck().get(), 0);

    // Recovery goes to everyone who heard about the problem.
    engine.record(change("crit", "ok"));
    advance(60_000);
    await engine.flush();
    assert.equal(out.sent.length, 6);
    assert.equal(out.sent[4]!.body.title, "[OK] Crashlooping pods");
  } finally {
    out.restore();
    await close();
  }
});

test("flapping inside the window sends once", async () => {
  const { m, call, close } = await setup();
  const out = stubDeliveries();
  try {
    await call("POST", "/channels", { kind: "webhook", label: "Hook", secret: HOOK });
    const { engine, advance } = clockedEngine(m);

    // Out and back inside the window: nothing.
    engine.record(change("ok", "crit"));
    advance(20_000);
    engine.record(change("crit", "ok"));
    advance(60_000);
    await engine.flush();
    assert.equal(out.sent.length, 0);

    // Flapping, settling on crit: one alert, from the status before the flap.
    for (const [from, to] of [
      ["ok", "crit"],
      ["crit", "ok"],
      ["ok", "warn"],
      ["warn", "crit"],
    ] as const) {
      engine.record(change(from, to));
      advance(10_000);
      await engine.flush();
    }
    advance(60_000);
    await engine.flush();
    await engine.flush();
    assert.equal(out.sent.length, 1);
    const payload = out.sent[0]!.body as unknown as WebhookPayload;
    assert.equal(payload.from, "ok");
    assert.equal(payload.to, "crit");

    // Same status again is deduplicated.
    engine.record(change("crit", "crit"));
    advance(60_000);
    await engine.flush();
    assert.equal(out.sent.length, 1);
  } finally {
    out.restore();
    await close();
  }
});

test("a check that never settles is sent once per max hold", async () => {
  const { m, call, close } = await setup();
  const out = stubDeliveries();
  try {
    await call("POST", "/channels", { kind: "webhook", label: "Hook", secret: HOOK });
    const { engine, advance } = clockedEngine(m, { debounceMs: 60_000, maxHoldMs: 300_000 });
    let status: Status = "ok";
    for (let i = 0; i < 35; i++) {
      const next: Status = status === "ok" ? "crit" : "ok";
      engine.record(change(status, next));
      status = next;
      advance(20_000);
      await engine.flush();
    }
    // 700s of flapping every 20s: at most one send per 300s hold.
    assert.ok(out.sent.length >= 1 && out.sent.length <= 3, `sent ${out.sent.length}`);
  } finally {
    out.restore();
    await close();
  }
});

test("routing: minimum severity and disabled channels", async () => {
  const { m, call, close } = await setup();
  const out = stubDeliveries();
  try {
    const [hook, ntfy, discord] = await threeChannels(call);
    await call("PUT", `/channels/${ntfy!.id}`, {
      kind: "ntfy",
      label: "Phone",
      enabled: false,
      config: { topic: "alerts" },
    });
    const { engine, advance } = clockedEngine(m);

    engine.record(change("ok", "warn"));
    advance(60_000);
    await engine.flush();
    assert.deepEqual(
      out.sent.map((s) => s.url),
      [HOOK],
      "warn reaches the warn channel only; crit-only Discord and disabled ntfy stay quiet"
    );

    engine.record(change("warn", "crit"));
    advance(60_000);
    await engine.flush();
    assert.deepEqual(
      out.sent.slice(1).map((s) => s.url),
      [HOOK, DISCORD]
    );

    // crit → warn is news for the warn channel, not for the crit one.
    engine.record(change("crit", "warn"));
    advance(60_000);
    await engine.flush();
    assert.deepEqual(
      out.sent.slice(3).map((s) => s.url),
      [HOOK]
    );

    // Recovery reaches both, because both were told about a problem.
    engine.record(change("warn", "ok"));
    advance(60_000);
    await engine.flush();
    assert.deepEqual(
      out.sent.slice(4).map((s) => s.url),
      [HOOK, DISCORD]
    );
    void hook;
    void discord;
  } finally {
    out.restore();
    await close();
  }
});

test("failed deliveries retry, then give up; the claim is released for the next change", async () => {
  const { m, call, close } = await setup();
  let failing = true;
  const out = stubDeliveries(() => (failing ? 500 : 200));
  try {
    await call("POST", "/channels", { kind: "webhook", label: "Hook", secret: HOOK });
    const { engine, advance } = clockedEngine(m);
    engine.record(change("ok", "crit"));
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      advance(10 * 60_000);
      await engine.flush();
    }
    assert.equal(out.sent.length, MAX_ATTEMPTS);
    assert.equal(m.ctx.db.prepare("SELECT count(*) FROM notify_pending").pluck().get(), 0);
    assert.equal(m.ctx.db.prepare("SELECT count(*) FROM notify_sent").pluck().get(), 0);

    failing = false;
    engine.record(change("crit", "crit"));
    advance(60_000);
    await engine.flush();
    assert.equal(out.sent.length, MAX_ATTEMPTS + 1, "still crit and never delivered, so it is sent");
  } finally {
    out.restore();
    await close();
  }
});

test("shouldSend", () => {
  assert.equal(shouldSend("warn", "ok", "warn"), true);
  assert.equal(shouldSend("crit", "ok", "warn"), false);
  assert.equal(shouldSend("warn", "crit", "crit"), false);
  assert.equal(shouldSend("crit", "crit", "warn"), false);
  assert.equal(shouldSend("crit", "crit", "ok"), true);
  assert.equal(shouldSend("warn", "ok", "ok"), false);
  assert.equal(shouldSend("warn", "crit", "unknown"), false);
  assert.equal(shouldSend("warn", "warn", "absent"), false);
});

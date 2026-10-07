import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../../src/app.js";
import type { Module } from "../../src/contracts/module.js";
import { createPlatform } from "../../src/platform/index.js";
import { DRAINING_MESSAGE, drainDeadlineMs } from "../../src/platform/shutdown.js";
import { openDatabase } from "../../src/runtime/db.js";
import { createRuntime } from "../../src/runtime/index.js";
import { silentLogger } from "../../src/runtime/log.js";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("DRAIN_MS sets the deadline, with a default for anything unusable", () => {
  assert.equal(drainDeadlineMs({}), 600_000);
  assert.equal(drainDeadlineMs({ DRAIN_MS: "1500" }), 1500);
  assert.equal(drainDeadlineMs({ DRAIN_MS: "soon" }), 600_000);
});

// One test, in order, because a drain is one-way: there is no undoing it in
// a process, and a real pod never needs to.
test("SIGTERM drains: changes refused, reads kept, readiness flipped, streams ended, then exit", async () => {
  process.env.DEV_AUTH = "1";
  const slow: { release?: () => void } = {};
  // A module's own routes, so the guard is shown to sit in front of them.
  const hosts: Module = {
    id: "hosts",
    milestone: "A",
    register(ctx) {
      ctx.route("GET /api/hosts", () => []);
      ctx.route("POST /api/hosts", () => ({}) as never);
      ctx.route("GET /api/hosts/:id", (_req, res) => {
        slow.release = () => res.json({ slow: true });
        return undefined;
      });
    },
  };
  const db = openDatabase(":memory:");
  const runtime = await createRuntime({
    db,
    dataDir: "/tmp",
    modules: [hosts],
    createPlatform,
    logFor: () => silentLogger,
  });
  const app = createApp(runtime, { version: "abc1234" });
  app.get("/stream", (_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write("data: {}\n\n");
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const realExit = process.exit;
  const listeners = { TERM: process.listeners("SIGTERM"), INT: process.listeners("SIGINT") };
  let exitCode: number | undefined;
  const exit: { resolve?: () => void } = {};
  const exited = new Promise<void>((resolve) => {
    exit.resolve = resolve;
  });
  let stopped = false;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    exit.resolve?.();
  }) as typeof process.exit;
  try {
    runtime.platform.handleSignals(server, async () => {
      stopped = true;
      await runtime.stop();
    });

    assert.deepEqual(await (await fetch(`${origin}/healthz`)).json(), { status: "ok", version: "abc1234" });
    assert.equal((await fetch(`${origin}/api/hosts`, { method: "POST" })).status, 200);

    const slowReply = fetch(`${origin}/api/hosts/x`);
    while (slow.release === undefined) await tick(10);
    const stream = await fetch(`${origin}/stream`);
    const streamDone = stream.text();

    process.emit("SIGTERM", "SIGTERM");
    await tick(50);
    assert.equal(runtime.platform.draining(), true);
    // The event stream is ended so its client reconnects to the new pod.
    assert.equal(await streamDone, "data: {}\n\n");

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`${origin}/api/hosts`, { method });
      assert.equal(res.status, 503, method);
      assert.equal(res.headers.get("retry-after"), "5");
      assert.deepEqual(await res.json(), { error: DRAINING_MESSAGE });
    }
    // Refused before anything parses it.
    const bad = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    assert.equal(bad.status, 503);

    assert.equal((await fetch(`${origin}/api/hosts`)).status, 200);
    const health = await fetch(`${origin}/healthz`);
    assert.equal(health.status, 503);
    assert.deepEqual(await health.json(), { status: "draining" });
    assert.equal((await fetch(`${origin}/livez`)).status, 200);

    await tick(600);
    assert.equal(stopped, false, "stopped while a request was in flight");
    assert.equal(exitCode, undefined);

    slow.release();
    assert.deepEqual(await (await slowReply).json(), { slow: true });
    await exited;
    assert.equal(stopped, true);
    assert.equal(exitCode, 0);
  } finally {
    process.exit = realExit;
    for (const l of process.listeners("SIGTERM")) if (!listeners.TERM.includes(l)) process.off("SIGTERM", l);
    for (const l of process.listeners("SIGINT")) if (!listeners.INT.includes(l)) process.off("SIGINT", l);
    server.closeAllConnections();
    server.close();
    db.close();
    delete process.env.DEV_AUTH;
  }
});

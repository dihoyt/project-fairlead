import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createScheduler } from "../../src/runtime/scheduler.js";
import { silentLogger } from "../../src/runtime/log.js";

const noJitter = () => 0;

test("runs immediately, then on the interval", async () => {
  const core = createScheduler(silentLogger, noJitter);
  let runs = 0;
  core.forModule("demo").every("tick", 40, () => void runs++, { jitterMs: 0 });
  await sleep(110);
  await core.stopAll();
  assert.ok(runs >= 2 && runs <= 4, `ran ${runs} times`);
});

test("a throwing job is recorded, not raised, and keeps running", async () => {
  const core = createScheduler(silentLogger, noJitter);
  const handle = core.forModule("demo").every("boom", 1000, () => {
    throw new Error("kaput");
  });
  await handle.runNow();
  await handle.runNow();
  const [status] = core.list();
  assert.equal(status!.lastOk, false);
  assert.equal(status!.lastError, "kaput");
  assert.ok(status!.failures >= 2);
  await core.stopAll();
});

test("a run past its timeout fails and its signal aborts", async () => {
  const core = createScheduler(silentLogger, noJitter);
  let aborted = false;
  const handle = core.forModule("demo").every(
    "slow",
    10_000,
    (signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
      }),
    { timeoutMs: 30, runImmediately: false }
  );
  await handle.runNow();
  assert.equal(aborted, true);
  assert.match(core.list()[0]!.lastError ?? "", /Timed out/);
  await core.stopAll();
});

test("runs never overlap", async () => {
  const core = createScheduler(silentLogger, noJitter);
  let concurrent = 0;
  let peak = 0;
  core.forModule("demo").every(
    "long",
    10,
    async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await sleep(50);
      concurrent--;
    },
    { jitterMs: 0, timeoutMs: 1000 }
  );
  await sleep(120);
  await core.stopAll();
  assert.equal(peak, 1);
});

test("heartbeat and next run are reported; list is per module", async () => {
  const core = createScheduler(silentLogger, noJitter);
  core.forModule("a").every("one", 20, () => {}, { jitterMs: 0 });
  core.forModule("b").every("two", 20, () => {}, { jitterMs: 0 });
  await sleep(50);
  const a = core.forModule("a").list();
  assert.equal(a.length, 1);
  assert.ok(a[0]!.heartbeatAt);
  assert.ok(a[0]!.nextRunAt);
  assert.equal(core.list().length, 2);
  await core.stopAll();
});

test("duplicate job names in one module are refused", async () => {
  const core = createScheduler(silentLogger, noJitter);
  const s = core.forModule("demo");
  s.every("dup", 1000, () => {});
  assert.throws(() => s.every("dup", 1000, () => {}), /already scheduled/);
  await core.stopAll();
});

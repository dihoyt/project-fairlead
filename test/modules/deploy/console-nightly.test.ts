import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { ConsoleNightlyView, DeployJobView } from "../../../src/contracts/deploy.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { createMockStorageTargets } from "../../../src/contracts/mocks/connectors/storage.js";
import { createMockContext, type MockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import { createConsoleDatabase } from "../../../src/modules/deploy/actions/console-backup.js";
import type { ConsoleDatabase } from "../../../src/modules/deploy/actions/index.js";
import mod, { registerDeploy } from "../../../src/modules/deploy/index.js";
import type { Deployer } from "../../../src/modules/deploy/runner.js";
import { listen } from "../../runtime/helpers.js";

const IMAGE = "docker.io/alpine/k8s@sha256:1111111111111111111111111111111111111111111111111111111111111111";

let env:
  | { mock: MockContext; deployer: Deployer; tick(): Promise<void>; server: { url: string; close(): Promise<void> } }
  | undefined;

afterEach(async () => {
  if (!env) return;
  env.deployer.stop();
  await env.server.close();
  await env.mock.close();
  env = undefined;
});

const db: ConsoleDatabase = {
  pod: { name: "console-abc", namespace: "console" },
  release: "console",
  keep: () => 14,
  snapshot: (name) => ({ path: `x/${name}`, bytes: 1 }),
};

// The minute MOCK_NOW falls in is the one the schedule names.
async function setup(schedule = "0 12 * * *", now = MOCK_NOW) {
  const k8s = createFakeK8s({
    objects: [
      {
        ref: RESOURCES.pods,
        items: [
          {
            metadata: { name: "console-abc", namespace: "console" },
            spec: { nodeName: "node-a", volumes: [{ name: "data", persistentVolumeClaim: { claimName: "console" } }] },
          },
        ],
      },
    ] as Array<{ ref: (typeof RESOURCES)[keyof typeof RESOURCES]; items: KubeObject[] }>,
  });
  const targets = createMockStorageTargets();
  targets.targets = targets.targets.filter((t) => t.id === "cn_st1");
  const mock = createMockContext("deploy", {
    migrations: mod.migrations,
    settings: {
      "deploy.image": IMAGE,
      "deploy.namespace": "console",
      "deploy.release": "console",
      "deploy.consoleBackup": schedule,
    },
    services: { k8s, "storage-targets": targets },
  });
  const { deployer, consoleBackup } = registerDeploy(mock.ctx, { now: () => now, consoleDatabase: db });
  env = { mock, deployer, tick: consoleBackup.tick, server: await listen(mock.app) };
  return env;
}

const runs = (e: NonNullable<typeof env>): DeployJobView[] =>
  e.deployer.list("console", 10).filter((j) => j.action === "console-backup");

test("a due slot starts one copy as the schedule, and a second tick in it starts none", async () => {
  const e = await setup();
  await e.tick();
  await e.tick();
  const started = runs(e);
  assert.equal(started.length, 1);
  assert.equal(started[0]!.startedBy, "schedule");
});

test("a tick a few minutes late still catches the slot; one outside it does nothing", async () => {
  const late = await setup("55 11 * * *");
  await late.tick();
  assert.equal(runs(late).length, 1);
  await afterEachNow();
  const off = await setup("0 3 * * *");
  await off.tick();
  assert.equal(runs(off).length, 0);
});

async function afterEachNow() {
  env!.deployer.stop();
  await env!.server.close();
  await env!.mock.close();
  env = undefined;
}

test("the view names the schedule, the target and the next run", async () => {
  const e = await setup("30 3 * * *");
  const view = (await (await fetch(`${e.server.url}/api/deploy/console-backup`)).json()) as ConsoleNightlyView;
  assert.equal(view.schedule, "30 3 * * *");
  assert.equal(view.keep, 14);
  assert.equal(view.target?.connectorId, "cn_st1");
  assert.equal(view.blockedBy, undefined);
  assert.equal(view.nextAt, "2026-10-08T03:30:00.000Z");
});

test("the copy is a whole, readable database written beside the original", () => {
  const dir = mkdtempSync(join(tmpdir(), "console-db-"));
  const file = join(dir, "console.db");
  const live = new Database(file);
  live.pragma("journal_mode = WAL");
  live.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')");
  const copier = createConsoleDatabase(
    live,
    { namespace: () => "console", release: () => "console", consoleBackupKeep: () => 5 },
    { NODE_ENV: "production", HOSTNAME: "console-abc" }
  )!;
  assert.deepEqual(copier.pod, { name: "console-abc", namespace: "console" });
  const { path, bytes } = copier.snapshot("copy.db");
  assert.ok(bytes > 0);
  assert.ok(existsSync(join(dir, path)));
  const copy = new Database(join(dir, path), { readonly: true });
  assert.deepEqual(copy.prepare("SELECT v FROM t").all(), [{ v: "kept" }]);
  assert.equal(readFileSync(join(dir, path)).subarray(0, 15).toString(), "SQLite format 3");
  copy.close();
  live.close();
  rmSync(dir, { recursive: true, force: true });
});

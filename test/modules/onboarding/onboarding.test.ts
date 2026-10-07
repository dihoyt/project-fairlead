import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { OnboardingState } from "../../../src/contracts/onboarding.js";
import { createMockBackupSource } from "../../../src/contracts/mocks/backups.js";
import { createMockContext, mockAdmin, mockViewer, type MockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s, mockClusterObjects } from "../../../src/contracts/mocks/k8s.js";
import { apiMocks } from "../../../src/contracts/mocks/api.js";
import onboarding, { STEPS } from "../../../src/modules/onboarding/index.js";
import { listen } from "../../runtime/helpers.js";

let open: Array<{ m: MockContext; close(): Promise<void> }> = [];

afterEach(async () => {
  for (const { m, close } of open) {
    await close();
    await m.close();
  }
  open = [];
});

async function start(options: { k8s?: boolean } = {}) {
  const m = createMockContext("onboarding", {
    migrations: onboarding.migrations,
    services: options.k8s === false ? {} : { k8s: createFakeK8s({ objects: mockClusterObjects() }) },
  });
  await onboarding.register(m.ctx);
  m.ctx.backups.addSource(createMockBackupSource("longhorn"));
  m.ctx.backups.addSource(createMockBackupSource("velero"));
  m.ctx.backups.addSource(createMockBackupSource("absent", "absent"));
  const server = await listen(m.app);
  open.push({ m, close: server.close });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${server.url}/api/onboarding${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as OnboardingState & { error?: string } };
  };
  return { m, call };
}

const stepOf = (state: OnboardingState, id: string) => state.steps.find((s) => s.id === id)!;

test("a fresh install lists every step in wizard order, none finished but the password", async () => {
  const { call } = await start();
  const { status, json } = await call("GET", "/state");
  assert.equal(status, 200);
  assert.deepEqual(
    json.steps.map((s) => s.id),
    STEPS.map((s) => s.id)
  );
  assert.equal(json.complete, false);
  assert.deepEqual(stepOf(json, "password"), { id: "password", optional: false, done: true, skipped: false });
  for (const step of json.steps.filter((s) => s.id !== "password")) {
    assert.equal(step.done || step.skipped, false, step.id);
  }
  assert.equal(stepOf(json, "findings").optional, false);
  assert.equal(stepOf(json, "oidc").optional, true);
});

test("findings count unhealthy nodes, PVCs no source covers, and volumes whose last attempt failed", async () => {
  const { call } = await start();
  const { json } = await call("GET", "/state");
  assert.deepEqual(json.findings, apiMocks["GET /api/onboarding/state"].findings);
  assert.deepEqual(json.findings, { unprotectedPvcs: 1, unhealthyNodes: 1, failingBackups: 1 });
});

test("without a cluster connection the cluster counts stay at zero and the state still answers", async () => {
  const { call } = await start({ k8s: false });
  const { status, json } = await call("GET", "/state");
  assert.equal(status, 200);
  assert.deepEqual(json.findings, { unprotectedPvcs: 0, unhealthyNodes: 0, failingBackups: 1 });
});

test("a failing backup source is logged and counted as nothing, not an error", async () => {
  const { m, call } = await start({ k8s: false });
  m.ctx.backups.addSource({
    id: "broken",
    label: "broken",
    list: async () => {
      throw new Error("boom");
    },
  });
  const { status, json } = await call("GET", "/state");
  assert.equal(status, 200);
  assert.equal(json.findings.failingBackups, 1);
});

test("done and skip are stored, audited, and the wizard completes once every step is settled", async () => {
  const { m, call } = await start();
  let state: OnboardingState | undefined;
  for (const { id } of STEPS.filter((s) => s.id !== "password")) {
    const action = id === "oidc" ? "skip" : "done";
    const res = await call("POST", `/steps/${id}`, { action });
    assert.equal(res.status, 200, id);
    state = res.json;
  }
  assert.ok(state);
  assert.equal(state.complete, true);
  assert.deepEqual(stepOf(state, "oidc"), { id: "oidc", optional: true, done: false, skipped: true });
  assert.equal(stepOf(state, "hosts").done, true);
  assert.deepEqual(m.audit.at(0), { actor: mockAdmin.id, action: "onboarding.done", target: "cluster" });
  assert.ok(m.audit.some((e) => e.action === "onboarding.skip" && e.target === "oidc"));
  assert.equal((await call("GET", "/state")).json.complete, true);
});

test("a later action replaces an earlier one", async () => {
  const { call } = await start();
  await call("POST", "/steps/hosts", { action: "skip" });
  const { json } = await call("POST", "/steps/hosts", { action: "done" });
  assert.deepEqual(stepOf(json, "hosts"), { id: "hosts", optional: true, done: true, skipped: false });
});

test("the password step follows the account and cannot be set", async () => {
  const { m, call } = await start();
  const res = await call("POST", "/steps/password", { action: "done" });
  assert.equal(res.status, 400);
  m.setUser({ ...mockAdmin, mustChangePassword: true });
  assert.equal(stepOf((await call("GET", "/state")).json, "password").done, false);
});

test("unknown steps are 404 and bad actions 400", async () => {
  const { call } = await start();
  assert.equal((await call("POST", "/steps/nope", { action: "done" })).status, 404);
  assert.equal((await call("POST", "/steps/hosts", { action: "finish" })).status, 400);
  assert.equal((await call("POST", "/steps/hosts")).status, 400);
});

test("readers see the state but only admins change it", async () => {
  const { m, call } = await start();
  m.setUser(mockViewer);
  assert.equal((await call("GET", "/state")).status, 200);
  assert.equal((await call("POST", "/steps/hosts", { action: "done" })).status, 403);
  assert.equal(m.audit.length, 0);
});

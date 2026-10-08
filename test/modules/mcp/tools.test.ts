import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckView } from "../../../src/contracts/checks.js";
import type { RouteKey } from "../../../src/contracts/api.js";
import { mockCheck } from "../../../src/contracts/mocks/api.js";
import type { CallInput } from "../../../src/contracts/module.js";
import { TOOLS, unexpectedStatus, type Caller } from "../../../src/modules/mcp/tools.js";

function fakeCaller(checks: CheckView[]) {
  const calls: Array<{ key: RouteKey; input?: CallInput<RouteKey> }> = [];
  const call = (async (key: RouteKey, input?: CallInput<RouteKey>) => {
    calls.push({ key, ...(input ? { input } : {}) });
    if (key === "GET /api/checks") return checks;
    return { ok: true };
  }) as Caller;
  return { call, calls };
}

const failingOn = (httpStatus: number, extra: Partial<CheckView> = {}): CheckView => ({
  ...mockCheck,
  kind: "http",
  ...extra,
  last: { ...mockCheck.last!, status: "warn", raw: { httpStatus } },
});

test("unexpectedStatus offers only a non-5xx status the check failed on", () => {
  assert.equal(unexpectedStatus(failingOn(401)), 401);
  assert.equal(unexpectedStatus(failingOn(503)), undefined);
  assert.equal(unexpectedStatus(failingOn(401, { expectStatus: [401] })), undefined);
  assert.equal(unexpectedStatus({ ...mockCheck, last: { ...mockCheck.last!, status: "ok" } }), undefined);
});

test("accept_check_status adds the code to the usual 2xx/3xx and re-runs", async () => {
  const check = failingOn(401, { id: "c1", authHeader: "X-Key", hasSecret: true });
  const { call, calls } = fakeCaller([check]);
  await TOOLS.accept_check_status.run(call, { id: "c1" });
  const put = calls.find((c) => c.key === "PUT /api/checks/:id")!;
  const body = put.input!.body as { expectStatus: number[]; secret?: string; authHeader?: string };
  assert.deepEqual(body.expectStatus, [200, 204, 301, 302, 303, 307, 308, 401]);
  assert.equal(body.authHeader, "X-Key");
  assert.ok(!("secret" in body), "the stored secret is kept by omitting it");
  assert.ok(calls.some((c) => c.key === "POST /api/checks/:id/run"));

  await assert.rejects(
    TOOLS.accept_check_status.run(fakeCaller([failingOn(502, { id: "c1" })]).call, { id: "c1" }),
    /did not fail/
  );
  await assert.rejects(TOOLS.accept_check_status.run(fakeCaller([]).call, { id: "c1" }), /No check "c1"/);
});

test("update_check changes only the given fields", async () => {
  const { call, calls } = fakeCaller([{ ...mockCheck, id: "c1" }]);
  await TOOLS.update_check.run(call, { id: "c1", label: "Renamed" });
  const body = calls.find((c) => c.key === "PUT /api/checks/:id")!.input!.body as Record<string, unknown>;
  assert.equal(body.label, "Renamed");
  assert.equal(body.target, mockCheck.target);
  assert.equal(body.intervalMs, mockCheck.intervalMs);
});

test("every tool's input schema is an object schema", () => {
  for (const [name, def] of Object.entries(TOOLS)) assert.equal(def.input.type, "object", name);
});

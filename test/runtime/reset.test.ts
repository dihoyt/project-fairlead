import assert from "node:assert/strict";
import { test } from "node:test";
import { RESET_SCOPES, RESET_SCOPE_INFO } from "../../src/contracts/reset.js";
import { createMockContext } from "../../src/contracts/mocks/context.js";

test("every scope has exactly one form row, and credentials are never preselected", () => {
  assert.deepEqual(
    RESET_SCOPE_INFO.map((info) => info.scope),
    [...RESET_SCOPES]
  );
  for (const scope of ["sshKey", "adminPassword"] as const) {
    assert.equal(RESET_SCOPE_INFO.find((info) => info.scope === scope)?.preselected, false);
  }
});

test("a module context registers reset handlers, several per scope", async () => {
  const mock = createMockContext("checks");
  mock.ctx.reset.add({ scope: "links", settingKeys: ["health.links"] });
  mock.ctx.reset.add({ scope: "links", settingKeys: ["workloads.headlampUrl"] });
  assert.equal(mock.ctx.reset.list().length, 2);
  await mock.close();
});

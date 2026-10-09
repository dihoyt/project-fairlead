// install.sh refuses any env-file key the console would not read, so its
// allow list and the contract's must stay the same.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { INSTALL_SEED_KEYS, INSTALL_SEED_SECRET } from "../../src/contracts/onboarding.js";

const script = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");

for (const name of ["install.sh", "update.sh"]) {
  test(`${name} allows exactly the contract's seed keys`, () => {
    const match = /^SEED_KEYS="([^"]*)"$/m.exec(script(name));
    assert.ok(match, "no SEED_KEYS line");
    assert.deepEqual(match[1]!.split(/\s+/).filter(Boolean).toSorted(), [...INSTALL_SEED_KEYS].toSorted());
  });
}

test("the seed Secret name matches the contract", () => {
  assert.match(script("install.sh"), new RegExp(`^SEED_SECRET_NAME="${INSTALL_SEED_SECRET.name}"$`, "m"));
});

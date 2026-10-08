import { test } from "node:test";
import assert from "node:assert/strict";
import type { InstallSource } from "../../src/contracts/catalog.js";
import { pickVersion, satisfiesKubeVersion } from "../../src/contracts/kubeversion.js";

const k3s = "v1.31.4+k3s1";

test("kubeVersion constraints as charts write them", () => {
  const cases: Array<[string | undefined, boolean]> = [
    [undefined, true],
    ["", true],
    [">=1.25.0-0", true],
    [">=1.34.0-0", false],
    ["< 1.37.0-0", true],
    [">= 1.21.0-0 < 1.31.0-0", false],
    [">=1.21.0-0, <1.32.0-0", true],
    ["^1.25.0-0", true],
    ["~1.30.0", false],
    ["~1.31.0", true],
    [">=1.34.0 || >=1.31.0 <1.32.0", true],
    ["1.31.4", true],
    ["not a constraint", false],
  ];
  for (const [constraint, expected] of cases) {
    assert.equal(satisfiesKubeVersion(constraint, k3s), expected, String(constraint));
  }
  assert.equal(satisfiesKubeVersion(">=1.34.0-0", "v1.34.0-rc.1"), true);
});

test("pickVersion keeps the pin when it fits, falls back when not, and blocks with the reason", () => {
  const install: InstallSource = {
    kind: "helm",
    repo: "https://charts.example.test",
    chart: "longhorn",
    version: "1.13.0",
    kubeVersion: ">=1.34.0-0",
    fallbacks: [{ version: "1.12.1", kubeVersion: ">=1.25.0-0" }],
  };
  assert.deepEqual(pickVersion(install, "v1.34.1"), {
    ok: true,
    version: "1.13.0",
    kubeVersion: ">=1.34.0-0",
    fellBack: false,
  });
  assert.deepEqual(pickVersion(install, k3s), {
    ok: true,
    version: "1.12.1",
    kubeVersion: ">=1.25.0-0",
    fellBack: true,
  });
  assert.deepEqual(pickVersion(install, undefined), {
    ok: true,
    version: "1.13.0",
    kubeVersion: ">=1.34.0-0",
    fellBack: false,
  });
  const blocked = pickVersion(install, "v1.24.0");
  assert.equal(blocked.ok, false);
  assert.match(blocked.ok ? "" : blocked.reason, /this cluster runs v1\.24\.0/);
  assert.deepEqual(pickVersion({ kind: "manifest", url: "https://example.test/x.yaml", version: "v1" }, k3s), {
    ok: true,
    version: "v1",
    fellBack: false,
  });
});

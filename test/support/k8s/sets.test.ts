import { test } from "node:test";
import assert from "node:assert/strict";
import { CoreV1Api, CustomObjectsApi } from "@kubernetes/client-node";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { STATUS_SEVERITY } from "../../../src/contracts/health.js";
import { MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import { judgeAll, type Bundle, type GitRepo } from "../../../src/modules/fleet/provider.js";
import { fixtureItems, listFixtureSets, loadFixtureSet } from "./fixtures.js";
import { startFakeApi } from "./fakeApi.js";

// Everything under test/fixtures/ is held to the same rules, so a real
// capture dropped in as test/fixtures/<name>/ is checked on arrival.
const sets = listFixtureSets();

const walk = (value: unknown) => {
  if (Array.isArray(value)) return value.forEach(walk);
  if (!value || typeof value !== "object") return;
  const o = value as Record<string, unknown>;
  if (Array.isArray(o.env)) {
    for (const e of o.env as Array<{ value?: string }>)
      assert.ok(e.value === undefined || e.value === "REDACTED", "env value");
  }
  for (const key of ["command", "args"]) {
    if (Array.isArray(o[key]))
      assert.ok(
        (o[key] as string[]).every((v) => v === "REDACTED"),
        key
      );
  }
  Object.values(o).forEach(walk);
};

test("there is a synthetic and a real set", () => {
  assert.ok(sets.includes("synthetic"));
  assert.ok(sets.includes("real"));
});

for (const name of sets) {
  const set = loadFixtureSet(name);

  test(`${name}: nothing a capture strips survives`, () => {
    const text = JSON.stringify(set.lists) + JSON.stringify(set.kubelet);
    assert.ok(!/[a-z]+:\/\/[^/"@\s]+:[^/"@\s]*@/.test(text), "URL credentials");
    assert.ok(!/H4sI[A-Za-z0-9+/]{20}/.test(text), "gzip+base64 blob");
    assert.ok(!/-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)/.test(text), "PEM block");
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(text), "JWT");
    walk(set.lists.map((l) => l.items));
    for (const { items } of set.lists) {
      for (const item of items) {
        for (const [key, value] of Object.entries(item.metadata.annotations ?? {})) {
          assert.ok(!key.endsWith("/applied") || value === "REDACTED", `${key} on ${item.metadata.name}`);
        }
      }
    }
  });

  test(`${name}: every list loads through a client-node call`, async () => {
    const api = await startFakeApi({ fixtures: set });
    try {
      const core = api.kubeConfig().makeApiClient(CoreV1Api);
      const custom = api.kubeConfig().makeApiClient(CustomObjectsApi);
      assert.equal((await core.listNode()).items.length, fixtureItems(set, RESOURCES.nodes).length);
      assert.equal((await core.listPodForAllNamespaces()).items.length, fixtureItems(set, RESOURCES.pods).length);
      for (const { ref, items } of set.lists.filter((l) => l.ref.group && !l.ref.group.endsWith("k8s.io"))) {
        const result = (await custom.listClusterCustomObject({
          group: ref.group,
          version: ref.version,
          plural: ref.plural,
        })) as { items: KubeObject[] };
        assert.equal(result.items.length, items.length, `${ref.group}/${ref.plural}`);
      }
      for (const { plural, group } of set.absent) {
        const res = await fetch(`${api.url}/apis/${group}/v1/${plural}`);
        assert.equal(res.status, 404, `${plural}.${group} should be absent`);
      }
    } finally {
      await api.close();
    }
  });

  // The Fleet judge, run over whatever the set holds: it must produce a
  // result with detail for every GitRepo, in a known status.
  test(`${name}: the Fleet provider judges every GitRepo`, () => {
    const repos = structuredClone(fixtureItems(set, RESOURCES.fleetGitRepos)) as GitRepo[];
    const bundles = structuredClone(fixtureItems(set, RESOURCES.fleetBundles)) as Bundle[];
    const results = judgeAll(repos, bundles, {
      now: new Date(MOCK_NOW),
      graceMs: 600_000,
      severity: {},
      rancherUrl: "",
    });
    assert.ok(results.length >= repos.length);
    for (const r of results) {
      assert.ok(STATUS_SEVERITY.includes(r.status), `${r.id} status ${r.status}`);
      assert.ok(r.detail, `${r.id} has no detail`);
    }
  });
}

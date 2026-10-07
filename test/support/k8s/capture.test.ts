import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixtureSet } from "./fixtures.js";

// capture-fixtures.sh strips with one jq program; these run that exact
// program, so the synthetic set stays a faithful stand-in for a capture.
const script = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/capture-fixtures.sh"),
  "utf8"
);
const strip = /read -r -d '' STRIP <<'JQ' \|\| true\n([\s\S]*?)\nJQ\n/.exec(script)?.[1];
const jq = spawnSync("jq", ["--version"]).status === 0;

const run = (input: unknown) => {
  const out = spawnSync("jq", ["-c", strip!], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
};

test("the strip program is extractable", () => assert.ok(strip));

test("capture's strip leaves the synthetic lists unchanged", { skip: !jq && "jq not installed" }, () => {
  for (const { ref, items } of loadFixtureSet("synthetic").lists) {
    const list = { apiVersion: "v1", kind: "List", items };
    assert.deepEqual(run(list), list, `${ref.group || "core"}/${ref.plural}`);
  }
});

test("capture's strip removes what kubectl's generic List wraps", { skip: !jq && "jq not installed" }, () => {
  const bundles = run({
    kind: "List",
    items: [
      {
        kind: "Bundle",
        metadata: { name: "b" },
        spec: { resources: [{ name: "x", content: "SECRET" }], helm: { values: { p: "q" } } },
      },
    ],
  });
  assert.deepEqual(bundles.items[0].spec, { resources: [{ name: "x" }], helm: { values: {} } });
  const nodes = run({
    kind: "List",
    items: [{ kind: "Node", metadata: { name: "n" }, status: { images: [{ names: ["a"] }], conditions: [] } }],
  });
  assert.deepEqual(nodes.items[0].status, { conditions: [] });
  const pod = run({
    kind: "List",
    items: [
      {
        kind: "Pod",
        metadata: {
          name: "p",
          managedFields: [{}],
          annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{}", "fleet.cattle.io/x": "1" },
        },
        spec: {
          containers: [
            {
              name: "c",
              command: ["sh"],
              args: ["-c"],
              env: [{ name: "K", value: "v" }],
              image: "https://user:pw@host/x",
            },
          ],
        },
      },
    ],
  }).items[0];
  assert.deepEqual(pod.metadata.annotations, { "fleet.cattle.io/x": "1" });
  assert.equal(pod.metadata.managedFields, undefined);
  assert.deepEqual(pod.spec.containers[0].env, [{ name: "K", value: "REDACTED" }]);
  assert.deepEqual(pod.spec.containers[0].command, ["REDACTED"]);
  assert.equal(pod.spec.containers[0].image, "https://REDACTED@host/x");
});

test("capture's strip redacts serialized and hash annotations it keeps", { skip: !jq && "jq not installed" }, () => {
  const annotations = {
    "objectset.rio.cattle.io/applied": "H4sIAAAAAAAA/6pWSs7PS8tMLQZ",
    "objectset.rio.cattle.io/id": "fleet-agent",
    "fleet.cattle.io/client-secret-hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "longhorn.io/last-applied-tolerations": '[{"key":"k"}]',
    "meta.helm.sh/release-name": "gitea",
    "kubectl.kubernetes.io/last-applied-configuration": '{"a":1}',
  };
  const out = run({ kind: "List", items: [{ kind: "Pod", metadata: { name: "p", annotations } }] }).items[0].metadata
    .annotations;
  assert.deepEqual(out, {
    "objectset.rio.cattle.io/applied": "REDACTED",
    "objectset.rio.cattle.io/id": "fleet-agent",
    "fleet.cattle.io/client-secret-hash": "REDACTED",
    "longhorn.io/last-applied-tolerations": "REDACTED",
    "meta.helm.sh/release-name": "gitea",
  });
});

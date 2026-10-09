import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RESTORE_SCRIPT, restoreFiles } from "../../../src/modules/deploy/actions/restore.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasTools = ["jq", "python3"].every((tool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0);

interface Fake {
  workloads: Record<string, number>;
  mounts: Record<string, string[]>;
  pvcs: Record<string, { volumeName: string; class: string }>;
  pvs: Record<string, { policy: string; class: string; claimRef?: string | null; phase?: string }>;
  lhvolumes?: Record<string, unknown>;
  jobs: Record<string, unknown>;
  data: Record<string, string>;
  calls: string[];
  seq: number;
  failRestore?: boolean;
  failRollout?: boolean;
}

const claim = {
  metadata: { name: "pg-data", namespace: "apps", labels: { app: "pg" } },
  spec: {
    accessModes: ["ReadWriteOnce"],
    resources: { requests: { storage: "10Gi" } },
    storageClassName: "longhorn",
    volumeName: "pvc-pg",
  },
};

function run(mode: "new-pvc" | "in-place", options: { failRestore?: boolean; failRollout?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "restore-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, "values"));
  writeFileSync(join(bin, "kubectl"), `#!/bin/sh\nexec python3 ${join(here, "fake-kubectl.py")} "$@"\n`);
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\n");
  for (const tool of ["kubectl", "sleep"]) chmodSync(join(bin, tool), 0o755);
  const files = restoreFiles({
    mode,
    namespace: "apps",
    claim,
    boundClaim: mode === "new-pvc" ? "pg-restored" : "pg-data",
    volume: "restore-1",
    backupUrl: "nfs://nas:/b?backup=backup-1&volume=pvc-pg",
    backupName: "backup-1",
    sizeBytes: "10737418240",
    replicas: 2,
    ...(mode === "in-place" ? { oldPv: "pvc-pg", oldReclaim: "Delete" } : {}),
    workloads: mode === "in-place" ? [{ kind: "statefulset", name: "pg", replicas: 1 }] : [],
    labels: { owner: "us" },
  });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "values", name), body);
  const state: Fake = {
    workloads: { "statefulset/pg": 1 },
    mounts: { "statefulset/pg": ["pg-data"] },
    pvcs: { "pg-data": { volumeName: "pvc-pg", class: "longhorn" } },
    pvs: { "pvc-pg": { policy: "Delete", class: "longhorn", claimRef: "pg-data", phase: "Bound" } },
    jobs: {},
    data: {},
    calls: [],
    seq: 0,
    ...options,
  };
  const stateFile = join(dir, "state.json");
  writeFileSync(stateFile, JSON.stringify(state));
  const result = spawnSync("sh", ["-c", RESTORE_SCRIPT.replaceAll("/values/", `${dir}/values/`)], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: stateFile },
  });
  const out = {
    status: result.status,
    lines: `${result.stdout}`.trim().split("\n"),
    stderr: result.stderr,
    state: JSON.parse(readFileSync(stateFile, "utf8")) as Fake,
  };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

test("restore to a new claim leaves the original alone", { skip: !hasTools }, () => {
  const out = run("new-pvc");
  assert.equal(out.status, 0, out.lines.join("\n") + out.stderr);
  assert.deepEqual(out.state.pvcs["pg-restored"], { volumeName: "restore-1", class: "longhorn" });
  assert.deepEqual(out.state.pvcs["pg-data"], { volumeName: "pvc-pg", class: "longhorn" });
  assert.equal(out.state.pvs["restore-1"]!.policy, "Delete");
  assert.equal(out.state.workloads["statefulset/pg"], 1);
  assert.ok(!out.state.calls.some((c) => c.startsWith("scale")));
});

test("restore in place swaps the claim to the restored volume and deletes the old one", { skip: !hasTools }, () => {
  const out = run("in-place");
  assert.equal(out.status, 0, out.lines.join("\n") + out.stderr);
  assert.deepEqual(out.state.pvcs["pg-data"], { volumeName: "restore-1", class: "longhorn" });
  assert.equal(out.state.pvs["pvc-pg"], undefined);
  assert.equal(out.state.pvs["restore-1"]!.policy, "Delete");
  assert.equal(out.state.workloads["statefulset/pg"], 1);
  assert.match(out.lines.at(-1)!, /^Restored pg-data in place from backup-1/);
});

test("a failed start puts the claim back on its old volume and discards the restored one", { skip: !hasTools }, () => {
  const out = run("in-place", { failRollout: true });
  assert.equal(out.status, 1);
  assert.deepEqual(out.state.pvcs["pg-data"], { volumeName: "pvc-pg", class: "longhorn" });
  assert.equal(out.state.pvs["pvc-pg"]!.policy, "Delete");
  assert.equal(out.state.pvs["restore-1"], undefined);
  assert.equal(out.state.lhvolumes?.["restore-1"], undefined);
  assert.equal(out.state.workloads["statefulset/pg"], 1);
  assert.match(out.lines.at(-1)!, /back on its old volume and nothing was deleted/);
});

test("a failed restore touches nothing the app uses", { skip: !hasTools }, () => {
  const out = run("in-place", { failRestore: true });
  assert.equal(out.status, 1);
  assert.deepEqual(out.state.pvcs["pg-data"], { volumeName: "pvc-pg", class: "longhorn" });
  assert.equal(out.state.pvs["pvc-pg"]!.policy, "Delete");
  assert.equal(out.state.lhvolumes?.["restore-1"], undefined);
  assert.ok(!out.state.calls.some((c) => c.includes("--replicas=0")));
  assert.match(out.lines.join("\n"), /faulted/);
});

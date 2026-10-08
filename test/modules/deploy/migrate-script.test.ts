import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATE_SCRIPT, migrationFiles, type MigrateInspection } from "../../../src/modules/deploy/actions/migrate.js";

// Runs the real convert script under sh against a fake kubectl, to prove
// the order of the PersistentVolume moves and every rollback path.

const here = dirname(fileURLToPath(import.meta.url));
const hasTools = ["sh", "jq", "python3"].every((tool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0);

const claim = (name: string): MigrateInspection["claims"][string] => ({
  apiVersion: "v1",
  kind: "PersistentVolumeClaim",
  metadata: {
    name,
    namespace: "gitea",
    labels: { "app.kubernetes.io/instance": "gitea" },
    annotations: { "meta.helm.sh/release-name": "gitea", "pv.kubernetes.io/bind-completed": "yes" },
  },
  spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } }, storageClassName: "local-path" },
});

const volume = (name: string, pv: string, n: number) => ({
  namespace: "gitea",
  claim: name,
  pv,
  storageClass: "local-path",
  size: "1Gi",
  sizeBytes: 1024 ** 3,
  reclaimPolicy: "Delete",
  tmpClaim: `${name}-longhorn`,
  copyJob: `gitea-copy-1-${n}`,
});

function inspection(checkUrl?: string): MigrateInspection {
  return {
    appId: "gitea",
    release: "gitea",
    namespace: "gitea",
    allowed: true,
    targetStorageClass: "longhorn",
    volumes: [volume("data", "pv-old-data", 0), volume("db", "pv-old-db", 1)],
    workloads: [
      { kind: "deployment", name: "gitea", replicas: 1 },
      { kind: "statefulset", name: "gitea-db", replicas: 1 },
    ],
    claims: { data: claim("data"), db: claim("db") },
    ...(checkUrl ? { checkUrl } : {}),
    helmSet: ["persistence.storageClass=longhorn"],
    helmArgv: ["helm", "upgrade", "gitea", "gitea", "--reuse-values", "--set", "persistence.storageClass=longhorn"],
    downtimeSeconds: 200,
    copyTimeoutSeconds: 600,
    longhornNodes: 1,
    warnings: [],
  };
}

interface Fake {
  workloads: Record<string, number>;
  mounts: Record<string, string[]>;
  pvcs: Record<string, { volumeName: string; class: string }>;
  pvs: Record<string, { policy: string; class: string; claimRef?: string | null; phase?: string }>;
  jobs: Record<string, unknown>;
  data: Record<string, string>;
  calls: string[];
  seq: number;
  failJobs?: string[];
}

function run(options: { failJobs?: string[]; httpCode?: string; checkUrl?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "migrate-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, "values"));
  mkdirSync(join(dir, "tmp"));
  writeFileSync(join(bin, "kubectl"), `#!/bin/sh\nexec python3 ${join(here, "fake-kubectl.py")} "$@"\n`);
  writeFileSync(join(bin, "curl"), `#!/bin/sh\nprintf '%s' "\${FAKE_HTTP_CODE:-200}"\n`);
  writeFileSync(join(bin, "helm"), `#!/bin/sh\necho "helm $*" >> ${join(dir, "helm.log")}\n`);
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\n");
  for (const tool of ["kubectl", "curl", "helm", "sleep"]) chmodSync(join(bin, tool), 0o755);

  for (const [name, body] of Object.entries(
    migrationFiles(inspection(options.checkUrl), { image: "img", runId: "1", ownedLabels: { owner: "us" } })
  )) {
    writeFileSync(join(dir, "values", name), body);
  }
  const state: Fake = {
    workloads: { "deployment/gitea": 1, "statefulset/gitea-db": 1 },
    mounts: { "deployment/gitea": ["data"], "statefulset/gitea-db": ["db"] },
    pvcs: {
      data: { volumeName: "pv-old-data", class: "local-path" },
      db: { volumeName: "pv-old-db", class: "local-path" },
    },
    pvs: {
      "pv-old-data": { policy: "Delete", class: "local-path", claimRef: "data", phase: "Bound" },
      "pv-old-db": { policy: "Delete", class: "local-path", claimRef: "db", phase: "Bound" },
    },
    jobs: {},
    data: { "pv-old-data": "repos", "pv-old-db": "rows" },
    calls: [],
    seq: 0,
    failJobs: options.failJobs ?? [],
  };
  const stateFile = join(dir, "state.json");
  writeFileSync(stateFile, JSON.stringify(state));
  const script = MIGRATE_SCRIPT.replaceAll("/tmp/", `${dir}/tmp/`).replaceAll("/values/", `${dir}/values/`);
  const result = spawnSync("sh", ["-c", script], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_STATE: stateFile,
      FAKE_HTTP_CODE: options.httpCode ?? "200",
    },
  });
  let helm = "";
  try {
    helm = readFileSync(join(dir, "helm.log"), "utf8");
  } catch {
    // Not run.
  }
  const out = {
    status: result.status,
    lines: `${result.stdout}`.trim().split("\n"),
    stderr: result.stderr,
    state: JSON.parse(readFileSync(stateFile, "utf8")) as Fake,
    helm,
  };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

test("convert moves each claim to a Longhorn copy under the same name", { skip: !hasTools }, () => {
  const out = run({ checkUrl: "http://gitea-http.gitea.svc:3000" });
  assert.equal(out.status, 0, out.lines.join("\n") + out.stderr);
  for (const [claimName, data] of [
    ["data", "repos"],
    ["db", "rows"],
  ] as const) {
    const pvc = out.state.pvcs[claimName]!;
    assert.equal(pvc.class, "longhorn");
    assert.equal(out.state.data[pvc.volumeName], data, "the copy carries the data");
    assert.equal(out.state.pvs[pvc.volumeName]?.policy, "Delete", "the new volume goes with its claim later");
  }
  assert.equal(out.state.pvs["pv-old-data"], undefined, "old volumes deleted after the check");
  assert.equal(out.state.pvs["pv-old-db"], undefined);
  assert.equal(out.state.pvcs["data-longhorn"], undefined, "no temporary claims left");
  assert.deepEqual(out.state.workloads, { "deployment/gitea": 1, "statefulset/gitea-db": 1 });
  assert.match(out.helm, /--set persistence\.storageClass=longhorn/);
  assert.match(out.lines.at(-1)!, /^Converted 2 volume\(s\) of gitea to Longhorn/);
  // The old volume is set to Retain before its claim is deleted.
  const retain = out.state.calls.findIndex((c) => c.startsWith("patch pv pv-old-data") && c.includes("Retain"));
  const remove = out.state.calls.findIndex((c) => c === "-n gitea delete pvc data --wait=true");
  assert.ok(retain >= 0 && remove > retain, out.state.calls.join("\n"));
});

test("a failed copy puts the app back on its old volumes", { skip: !hasTools }, () => {
  const out = run({ failJobs: ["gitea-copy-1-1"] });
  assert.equal(out.status, 1);
  assert.equal(out.state.pvcs.data!.volumeName, "pv-old-data", "the first, already switched claim is rebound");
  assert.equal(out.state.pvcs.db!.volumeName, "pv-old-db");
  assert.equal(out.state.pvs["pv-old-data"]?.policy, "Delete", "its policy is put back");
  assert.equal(out.state.pvs["pv-old-db"]?.policy, "Delete");
  assert.equal(out.state.pvcs["db-longhorn"], undefined);
  assert.equal(out.state.data["pv-old-data"], "repos");
  assert.ok(
    Object.keys(out.state.pvs).every((pv) => pv.startsWith("pv-old") || out.state.pvs[pv]?.policy === "Delete"),
    "Longhorn copies are left to be deleted"
  );
  assert.deepEqual(out.state.workloads, { "deployment/gitea": 1, "statefulset/gitea-db": 1 });
  assert.equal(out.helm, "");
  assert.match(
    out.lines.at(-1)!,
    /^Error while copying db: gitea is back on its old volumes and nothing was deleted\./
  );
});

test("an app that doesn't answer after the switch is rolled back too", { skip: !hasTools }, () => {
  const out = run({ checkUrl: "http://gitea-http.gitea.svc:3000", httpCode: "503" });
  assert.equal(out.status, 1);
  assert.equal(out.state.pvcs.data!.volumeName, "pv-old-data");
  assert.equal(out.state.pvcs.db!.volumeName, "pv-old-db");
  assert.equal(out.state.pvcs.data!.class, "local-path");
  assert.equal(
    Object.keys(out.state.pvs).filter((pv) => !pv.startsWith("pv-old")).length,
    0,
    "the Longhorn copies are deleted"
  );
  assert.deepEqual(out.state.workloads, { "deployment/gitea": 1, "statefulset/gitea-db": 1 });
  assert.match(out.lines.at(-1)!, /^Error while checking gitea answers/);
});

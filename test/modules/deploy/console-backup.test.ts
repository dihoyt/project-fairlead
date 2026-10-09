import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import {
  createMockStorageTargets,
  MOCK_STORAGE_SECRET_VALUE,
} from "../../../src/contracts/mocks/connectors/storage.js";
import { createFakeK8s, type FakeK8s } from "../../../src/contracts/mocks/k8s.js";
import {
  CONSOLE_BACKUP_SCRIPT,
  TARGET_DIR,
  backupFileName,
  lastGood,
} from "../../../src/modules/deploy/actions/console-backup.js";
import {
  actionRecipe,
  actionSchema,
  type ActionContext,
  type ActionRendered,
  type ConsoleDatabase,
} from "../../../src/modules/deploy/actions/index.js";
import { matches, nextRun, parseCron } from "../../../src/modules/deploy/cron.js";

const hasTools = ["sh", "awk", "sort"].every((tool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0);

function cluster(options: { emptyDir?: boolean; longhornUrl?: string } = {}): FakeK8s {
  return createFakeK8s({
    objects: [
      {
        ref: RESOURCES.pods,
        items: [
          {
            metadata: { name: "console-abc", namespace: "ops" },
            spec: {
              nodeName: "node-a",
              containers: [{ volumeMounts: [{ name: "data", mountPath: "/data" }] }],
              volumes: [
                options.emptyDir
                  ? { name: "data", emptyDir: {} }
                  : { name: "data", persistentVolumeClaim: { claimName: "console" } },
              ],
            },
          },
        ],
      },
      ...(options.longhornUrl
        ? [
            {
              ref: RESOURCES.longhornBackupTargets,
              items: [
                {
                  metadata: { name: "default", namespace: "longhorn-system" },
                  spec: { backupTargetURL: options.longhornUrl },
                },
              ],
            },
          ]
        : []),
    ] as Array<{ ref: (typeof RESOURCES)[keyof typeof RESOURCES]; items: KubeObject[] }>,
  });
}

function database(): ConsoleDatabase & { snapshots: string[] } {
  const snapshots: string[] = [];
  return {
    snapshots,
    pod: { name: "console-abc", namespace: "ops" },
    release: "console",
    keep: () => 14,
    snapshot(name) {
      snapshots.push(name);
      return { path: `x-console-backup/${name}`, bytes: 1024 };
    },
  };
}

function context(k8s: FakeK8s, overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    run: true,
    enabled: true,
    image: "img",
    call: () => Promise.reject(new Error("no calls here")),
    k8s,
    discover: async () => undefined,
    releases: [],
    versions: new Map(),
    storageTargets: createMockStorageTargets(),
    consoleDatabase: database(),
    ...overrides,
  };
}

async function render(request: { kind: "console-backup"; connectorId?: string; keep?: number }, ctx: ActionContext) {
  assert.ok(actionSchema.safeParse(request).success);
  return actionRecipe("console-backup")!.render(request, ctx) as Promise<ActionRendered>;
}

test("to an NFS target: the kubelet mounts the export and the Job runs beside the console's volume", async () => {
  const db = database();
  const r = await render(
    { kind: "console-backup", connectorId: "cn_st1" },
    context(cluster(), { consoleDatabase: db })
  );
  assert.equal(r.plan.allowed, true, r.plan.blockedBy);
  assert.equal(r.appId, "console");
  assert.equal(r.pod?.nodeName, "node-a");
  assert.deepEqual(r.pod?.volumes, [
    { name: "console", persistentVolumeClaim: { claimName: "console" } },
    { name: "target", nfs: { server: "nas.example.test", path: "/volume1/backups/cluster" } },
  ]);
  assert.equal(r.files.protocol, "nfs");
  assert.equal(r.files.keep, "14");
  assert.match(r.files.name!, /^console-\d{8}T\d{6}Z\.db$/);
  assert.equal(r.files.snapshot, `x-console-backup/${r.files.name}`);
  assert.deepEqual(db.snapshots, [r.files.name]);
  assert.equal(r.files.url, `nfs://nas.example.test:/volume1/backups/cluster/${TARGET_DIR}/`);
});

test("a plan writes no copy; a run does", async () => {
  const db = database();
  await render(
    { kind: "console-backup", connectorId: "cn_st1" },
    context(cluster(), { run: false, consoleDatabase: db })
  );
  assert.deepEqual(db.snapshots, []);
});

test("to S3: the keys reach the Job as files and never its log", async () => {
  const r = await render({ kind: "console-backup", connectorId: "cn_st2", keep: 3 }, context(cluster()));
  assert.equal(r.plan.allowed, true, r.plan.blockedBy);
  assert.equal(r.files.endpoint, "https://minio.example.test:9000");
  assert.equal(r.files.bucket, "cluster-backups");
  assert.equal(r.files.prefix, `${TARGET_DIR}/`);
  assert.equal(r.files["secret-key"], MOCK_STORAGE_SECRET_VALUE);
  assert.ok(r.secrets?.includes(MOCK_STORAGE_SECRET_VALUE));
  assert.equal(r.files.keep, "3");
  assert.ok(!JSON.stringify(r.plan).includes(MOCK_STORAGE_SECRET_VALUE));
});

test("the default target is the one Longhorn backs up to", async () => {
  const r = await render(
    { kind: "console-backup" },
    context(cluster({ longhornUrl: "s3://cluster-backups@us-east-1" }))
  );
  assert.equal(r.plan.allowed, true, r.plan.blockedBy);
  assert.equal(r.files.protocol, "s3");
});

test("refused: SMB, no lasting volume, outside the cluster, several targets and none chosen", async () => {
  const smb = await render({ kind: "console-backup", connectorId: "cn_st3" }, context(cluster()));
  assert.match(smb.plan.blockedBy!, /SMB/);
  const empty = await render({ kind: "console-backup", connectorId: "cn_st1" }, context(cluster({ emptyDir: true })));
  assert.match(empty.plan.blockedBy!, /no volume/);
  const outside = await render(
    { kind: "console-backup", connectorId: "cn_st1" },
    context(cluster(), { consoleDatabase: { ...database(), pod: undefined } })
  );
  assert.match(outside.plan.blockedBy!, /in the cluster/);
  const unsure = await render({ kind: "console-backup" }, context(cluster()));
  assert.match(unsure.plan.blockedBy!, /Pick a storage target/);
});

function runScript(files: Record<string, string>, existing: string[], fakeCurl?: string) {
  const dir = mkdtempSync(join(tmpdir(), "console-backup-"));
  for (const sub of ["values", "console/x-console-backup", `target/${TARGET_DIR}`, "bin", "bucket"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "values", name), body);
  writeFileSync(join(dir, "console", files.snapshot!), "SQLite format 3\0data");
  for (const name of existing) {
    writeFileSync(join(dir, `target/${TARGET_DIR}`, name), "old");
    writeFileSync(join(dir, "bucket", name), "old");
  }
  if (fakeCurl) {
    writeFileSync(join(dir, "bin", "curl"), fakeCurl.replaceAll("@BUCKET@", join(dir, "bucket")));
    chmodSync(join(dir, "bin", "curl"), 0o755);
  }
  const script = CONSOLE_BACKUP_SCRIPT.replaceAll("/values", `${dir}/values`)
    .replaceAll("/console/", `${dir}/console/`)
    .replaceAll("/target/", `${dir}/target/`);
  const result = spawnSync("sh", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` },
  });
  const out = {
    status: result.status,
    lines: `${result.stdout}`.trim().split("\n"),
    stderr: result.stderr,
    target: readdirSync(join(dir, `target/${TARGET_DIR}`)).toSorted(),
    bucket: readdirSync(join(dir, "bucket")).toSorted(),
    snapshotLeft: existsSync(join(dir, "console", files.snapshot!)),
  };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

const old = ["console-20261001T033000Z.db", "console-20261002T033000Z.db", "console-20261003T033000Z.db", "other.db"];

test("the NFS copy lands under its name, the oldest beyond keep go, the local copy goes", { skip: !hasTools }, () => {
  const out = runScript(
    {
      protocol: "nfs",
      name: "console-20261009T033000Z.db",
      keep: "2",
      release: "console",
      url: "nfs://nas:/b/x/",
      snapshot: "x-console-backup/console-20261009T033000Z.db",
    },
    old
  );
  assert.equal(out.status, 0, out.lines.join("\n") + out.stderr);
  assert.deepEqual(out.target, ["console-20261003T033000Z.db", "console-20261009T033000Z.db", "other.db"]);
  assert.equal(out.snapshotLeft, false);
  assert.match(out.lines.at(-1)!, /^Copied console-20261009T033000Z\.db \(\d+ bytes\) to nfs:\/\/nas:\/b\/x\/$/);
});

// Stands in for S3: -T uploads into a folder, a GET lists it as
// ListObjectsV2 XML, -X DELETE removes a key.
const FAKE_CURL = `#!/bin/sh
bucket="@BUCKET@"
upload=""; method=GET; url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -T) upload="$2"; shift 2 ;;
    -X) method="$2"; shift 2 ;;
    --aws-sigv4|--user) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
key=\${url##*/}
if [ -n "$upload" ]; then cp "$upload" "$bucket/$key"; exit 0; fi
if [ "$method" = DELETE ]; then rm -f "$bucket/$key"; exit 0; fi
printf '<ListBucketResult>'
for f in $(ls "$bucket"); do printf '<Contents><Key>x/%s</Key></Contents>' "$f"; done
printf '</ListBucketResult>'
`;

test("the S3 copy is uploaded and pruned through signed requests", { skip: !hasTools }, () => {
  const out = runScript(
    {
      protocol: "s3",
      name: "console-20261009T033000Z.db",
      keep: "2",
      release: "console",
      url: "s3://b@r/x/",
      endpoint: "https://minio.example.test",
      bucket: "b",
      region: "r",
      prefix: "x/",
      "access-key": "AK",
      "secret-key": "SK",
      snapshot: "x-console-backup/console-20261009T033000Z.db",
    },
    old,
    FAKE_CURL
  );
  assert.equal(out.status, 0, out.lines.join("\n") + out.stderr);
  assert.deepEqual(out.bucket, ["console-20261003T033000Z.db", "console-20261009T033000Z.db", "other.db"]);
  assert.equal(out.snapshotLeft, false);
});

const job = (state: "succeeded" | "failed", message: string) =>
  ({ action: "console-backup", state, message, createdAt: "2026-10-09T03:30:00Z" }) as never;

test("the newest succeeded run names the copy install.sh takes", () => {
  assert.deepEqual(lastGood([job("failed", "boom"), job("succeeded", "Copied console-1.db (12 bytes) to nfs://x/")]), {
    at: "2026-10-09T03:30:00Z",
    file: "console-1.db",
    sizeBytes: 12,
  });
  assert.equal(backupFileName("console", new Date("2026-10-09T03:30:05.123Z")), "console-20261009T033005Z.db");
});

test("cron: the nightly default, steps and refusals", () => {
  const nightly = parseCron("30 3 * * *")!;
  assert.ok(matches(nightly, new Date("2026-10-09T03:30:00Z")));
  assert.ok(!matches(nightly, new Date("2026-10-09T03:31:00Z")));
  assert.equal(nextRun(nightly, Date.parse("2026-10-09T04:00:00Z"))?.toISOString(), "2026-10-10T03:30:00.000Z");
  assert.ok(matches(parseCron("*/15 * * * 1-5")!, new Date("2026-10-09T10:45:00Z")));
  assert.equal(parseCron("30 3 * *"), null);
  assert.equal(parseCron("61 3 * * *"), null);
  assert.equal(parseCron("@daily"), null);
});

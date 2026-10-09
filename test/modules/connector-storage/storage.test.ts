import assert from "node:assert/strict";
import net from "node:net";
import { afterEach, test } from "node:test";
import {
  STORAGE_TARGET_KIND,
  type ConnectorInstance,
  type StorageTargetView,
} from "../../../src/contracts/connectors.js";
import { RESOURCES } from "../../../src/contracts/k8s.js";
import {
  createMockConnectorRegistry,
  type MockConnectorRegistry,
} from "../../../src/contracts/mocks/connectors/index.js";
import { createMockContext, type MockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s, type FakeK8s } from "../../../src/contracts/mocks/k8s.js";
import storage, { register } from "../../../src/modules/connector-storage/index.js";
import { createStorageKind } from "../../../src/modules/connector-storage/kind.js";
import { signGet, type Fetch } from "../../../src/modules/connector-storage/s3.js";
import { parseTarget, sameTarget, targetUrl } from "../../../src/modules/connector-storage/url.js";
import { product } from "../../../src/product.js";
import { listen } from "../../runtime/helpers.js";

const NOW = new Date("2026-10-09T01:00:00Z");
const signal = () => new AbortController().signal;

const nfs: ConnectorInstance = {
  id: "cn_nfs",
  kind: STORAGE_TARGET_KIND,
  name: "NAS",
  config: { protocol: "nfs", url: "nfs://nas.example.test:/volume1/backups", path: "cluster-a" },
  secrets: {},
};
const s3: ConnectorInstance = {
  id: "cn_s3",
  kind: STORAGE_TARGET_KIND,
  name: "MinIO",
  config: {
    protocol: "s3",
    url: "s3://backups@us-east-1/",
    endpoint: "https://minio.example.test:9000",
    accessKeyId: "AKIATEST",
  },
  secrets: { secretAccessKey: "s3-secret" },
};
const smb: ConnectorInstance = {
  id: "cn_smb",
  kind: STORAGE_TARGET_KIND,
  name: "Office share",
  config: { protocol: "smb", url: "cifs://files.example.test/backups", username: "backup" },
  secrets: { password: "smb-secret" },
};

test("parses Longhorn's target URL forms and puts the path prefix under them", () => {
  const n = parseTarget("nfs", "nfs://nas.example.test:/volume1/backups/");
  assert.deepEqual(n, { protocol: "nfs", server: "nas.example.test", path: "/volume1/backups" });
  assert.equal(targetUrl(n as never, "/cluster-a/"), "nfs://nas.example.test:/volume1/backups/cluster-a");
  const b = parseTarget("s3", "s3://backups@eu-west-2/");
  assert.equal(targetUrl(b as never, "cluster-a"), "s3://backups@eu-west-2/cluster-a/");
  assert.equal(targetUrl(b as never), "s3://backups@eu-west-2/");
  const c = parseTarget("smb", "cifs://files.example.test/backups");
  assert.equal(targetUrl(c as never, "k3s"), "cifs://files.example.test/backups/k3s");
  assert.match((parseTarget("smb", "smb://files/backups") as { error: string }).error, /cifs:\/\//);
  assert.match((parseTarget("nfs", "s3://x@y/") as { error: string }).error, /nfs:\/\/server:\/export/);
  assert.ok(sameTarget("nfs://nas:/a/b/", "nfs://nas:/a/b"));
});

test("signs requests as AWS's own SigV4 example does", () => {
  // The GET Bucket example from AWS's Signature Version 4 documentation.
  const signed = signGet({
    host: "examplebucket.s3.amazonaws.com",
    uri: "/",
    query: [
      ["max-keys", "2"],
      ["prefix", "J"],
    ],
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    now: new Date("2013-05-24T00:00:00Z"),
  });
  assert.match(
    signed.headers.authorization!,
    /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/
  );
});

test("nfs and smb: the port is checked, and settings errors say what to type", async () => {
  const knocked: string[] = [];
  const kind = createStorageKind({
    now: () => NOW,
    connect: async (host, port) => {
      knocked.push(`${host}:${port}`);
      if (host.startsWith("files")) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    },
  });
  const ok = await kind.verify(nfs.config, signal());
  assert.deepEqual(
    ok.map((c) => [c.id, c.status]),
    [["tcp", "ok"]]
  );
  assert.match(ok[0]!.detail, /nas\.example\.test:2049 accepts connections/);

  const refused = await kind.verify({ ...smb.config, ...smb.secrets }, signal());
  assert.equal(refused[0]!.status, "crit");
  assert.match(refused[0]!.detail, /files\.example\.test:445 refused the connection/);
  assert.equal((refused[0]!.raw as { code: string }).code, "ECONNREFUSED");

  const noPassword = await kind.verify(smb.config, signal());
  assert.deepEqual(
    noPassword.map((c) => [c.id, c.status, c.detail]),
    [["config", "crit", "Password is required for smb."]]
  );
  assert.deepEqual(knocked, ["nas.example.test:2049", "files.example.test:445"]);
});

test("s3: a signed ListObjectsV2 proves the keys; S3's error codes become sentences", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let answer = { status: 200, body: "<ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>" };
  const fetchFn: Fetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { status: answer.status, text: async () => answer.body };
  };
  const kind = createStorageKind({ now: () => NOW, connect: async () => {}, fetch: fetchFn });
  const values = { ...s3.config, ...s3.secrets, path: "cluster-a" };

  const ok = await kind.verify(values, signal());
  assert.deepEqual(
    ok.map((c) => [c.id, c.status]),
    [
      ["tcp", "ok"],
      ["list", "ok"],
    ]
  );
  assert.equal(calls[0]!.url, "https://minio.example.test:9000/backups?list-type=2&max-keys=1&prefix=cluster-a%2F");
  assert.match(
    calls[0]!.headers.authorization!,
    /^AWS4-HMAC-SHA256 Credential=AKIATEST\/20261009\/us-east-1\/s3\/aws4_request/
  );
  assert.ok(!JSON.stringify(calls).includes("s3-secret"));

  answer = { status: 403, body: "<Error><Code>SignatureDoesNotMatch</Code><Message>nope</Message></Error>" };
  const bad = await kind.verify(values, signal());
  assert.equal(bad[1]!.status, "crit");
  assert.equal(bad[1]!.detail, "The secret access key does not match the access key ID");
  assert.deepEqual(bad[1]!.raw, { status: 403, code: "SignatureDoesNotMatch", message: "nope" });
  assert.ok(!JSON.stringify(bad).includes("s3-secret"));
});

test("the real TCP check reaches a listening port and reports a closed one", async () => {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const kind = createStorageKind({ now: () => NOW });
  const values = {
    protocol: "s3",
    url: "s3://bkt@us-east-1/",
    endpoint: `http://127.0.0.1:${port}`,
    accessKeyId: "a",
    secretAccessKey: "b",
  };
  const kindNoS3 = createStorageKind({
    now: () => NOW,
    fetch: async () => ({ status: 200, text: async () => "<KeyCount>1</KeyCount>" }),
  });
  assert.equal((await kindNoS3.verify(values, signal()))[0]!.status, "ok");
  await new Promise((resolve) => server.close(resolve));
  const closed = await kind.verify(values, signal());
  assert.equal(closed[0]!.status, "crit");
  assert.match(closed[0]!.detail, /refused the connection/);
});

interface Setup {
  m: MockContext;
  registry: MockConnectorRegistry;
  k8s: FakeK8s;
  get<T>(path: string): Promise<{ status: number; body: T }>;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function setup(): Promise<Setup> {
  const registry = createMockConnectorRegistry([nfs, s3, smb]);
  const k8s = createFakeK8s();
  const m = createMockContext("connector-storage", {
    migrations: storage.migrations ?? [],
    services: { connectors: registry, k8s },
  });
  register(m.ctx, { now: () => NOW, connect: async () => {} });
  const server = await listen(m.app);
  closers.push(async () => {
    await server.close();
    await m.close();
  });
  return {
    m,
    registry,
    k8s,
    async get<T>(path: string) {
      const res = await fetch(`${server.url}/api/connector-storage${path}`);
      return { status: res.status, body: (await res.json()) as T };
    },
  };
}

const longhornTarget = (url: string, available: boolean, message?: string) => ({
  metadata: { name: "default", namespace: "longhorn-system" },
  spec: { backupTargetURL: url },
  status: {
    available,
    lastSyncedAt: "2026-10-09T00:55:00Z",
    ...(message ? { conditions: [{ type: "Unavailable", status: "True", message }] } : {}),
  },
});

test("lists targets with their URL, credential state, checks and what uses them", async () => {
  const s = await setup();
  s.registry.views.set("cn_nfs", {
    ...(await s.registry.view("cn_nfs"))!,
    status: "ok",
    checks: [{ id: "tcp", label: "NFS port", status: "ok", detail: "fine", observedAt: NOW.toISOString() }],
    checkedAt: NOW.toISOString(),
  });
  s.k8s.upsert(
    RESOURCES.longhornBackupTargets,
    longhornTarget("nfs://nas.example.test:/volume1/backups/cluster-a/", true)
  );

  const { status, body } = await s.get<StorageTargetView[]>("/targets");
  assert.equal(status, 200);
  assert.deepEqual(
    body.map((t) => [t.name, t.protocol, t.url, t.server, t.hasCredentials, t.status]),
    [
      ["MinIO", "s3", "s3://backups@us-east-1/", "minio.example.test", true, "unknown"],
      ["NAS", "nfs", "nfs://nas.example.test:/volume1/backups/cluster-a", "nas.example.test", false, "ok"],
      ["Office share", "smb", "cifs://files.example.test/backups", "files.example.test", true, "unknown"],
    ]
  );
  const nas = body.find((t) => t.id === "cn_nfs")!;
  assert.deepEqual(nas.usedBy, [
    { kind: "longhorn", label: "Longhorn backup target", available: true, lastSyncAt: "2026-10-09T00:55:00Z" },
  ]);
  assert.equal(nas.checks[0]!.detail, "fine");
  assert.ok(!JSON.stringify(body).includes("secret"));
  assert.equal((await s.get("/targets/cn_nope")).status, 404);
});

test("health adds Longhorn's own mount result once it is the backup target", async () => {
  const s = await setup();
  const kind = s.registry.kinds().find((k) => k.kind === STORAGE_TARGET_KIND)!;
  assert.equal((await kind.health!(nfs, signal())).length, 1);
  s.k8s.upsert(
    RESOURCES.longhornBackupTargets,
    longhornTarget("nfs://nas.example.test:/volume1/backups/cluster-a", false, "mount.nfs: access denied by server")
  );
  const checks = await kind.health!(nfs, signal());
  assert.deepEqual(
    checks.map((c) => [c.id, c.status]),
    [
      ["tcp", "ok"],
      ["longhorn", "crit"],
    ]
  );
  assert.equal(checks[1]!.detail, "Longhorn can't use it as its backup target: mount.nfs: access denied by server");
  const view = await s.m.ctx.services.get("storage-targets").get("cn_nfs");
  assert.equal(view!.usedBy[0]!.available, false);
  assert.equal(view!.usedBy[0]!.message, "mount.nfs: access denied by server");
});

test("credentialsSecret: Longhorn's keys for s3 and smb, nothing for nfs", async () => {
  const s = await setup();
  const svc = s.m.ctx.services.get("storage-targets");
  const forS3 = await svc.credentialsSecret("cn_s3", "longhorn-system");
  assert.deepEqual(forS3, {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: `${product.ownerMarker.externalPrefix}backup-cn-s3`,
      namespace: "longhorn-system",
      labels: { "app.kubernetes.io/managed-by": product.ownerMarker.labelDomain },
    },
    type: "Opaque",
    stringData: {
      AWS_ACCESS_KEY_ID: "AKIATEST",
      AWS_SECRET_ACCESS_KEY: "s3-secret",
      AWS_ENDPOINTS: "https://minio.example.test:9000",
    },
  });
  const forSmb = await svc.credentialsSecret("cn_smb", "longhorn-system");
  assert.deepEqual(forSmb!.stringData, { CIFS_USERNAME: "backup", CIFS_PASSWORD: "smb-secret" });
  assert.equal(await svc.credentialsSecret("cn_nfs", "longhorn-system"), undefined);
  await assert.rejects(svc.credentialsSecret("cn_nope", "longhorn-system"), /No storage target/);
  s.registry.addInstance({ ...smb, id: "cn_smb2", secrets: {} });
  await assert.rejects(svc.credentialsSecret("cn_smb2", "longhorn-system"), /no stored password/);
});

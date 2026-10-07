import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { HostTestResult, HostView } from "../../../src/contracts/hosts.js";
import { createMockContext, mockViewer } from "../../../src/contracts/mocks/context.js";
import hosts, { register } from "../../../src/modules/hosts/index.js";
import { startFakeSshHost, type FakeSshHost } from "../../support/index.js";
import { linuxHost, parseableKeyPair, truenasHost } from "./fixtures.js";

async function setup(table = linuxHost()) {
  const keys = parseableKeyPair();
  const fake = await startFakeSshHost({
    publicKey: keys.publicKey,
    hostKey: parseableKeyPair().privateKey,
    commands: table,
  });
  const m = createMockContext("hosts", { migrations: hosts.migrations ?? [] });
  const service = register(m.ctx);
  const server: Server = await new Promise((resolve) => {
    const s = m.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/hosts`;
  const call = async <T = unknown>(method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T & { error?: string } };
  };
  const request = (fakeHost: FakeSshHost, extra: Record<string, unknown> = {}) => ({
    label: "Box",
    address: fakeHost.host,
    port: fakeHost.port,
    username: fakeHost.username,
    auth: "key",
    credential: keys.privateKey,
    ...extra,
  });
  return {
    m,
    fake,
    keys,
    service,
    call,
    request: (extra?: Record<string, unknown>) => request(fake, extra),
    async close() {
      await service.settle();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await m.close();
      await fake.close();
    },
  };
}

test("create stores the key in the secret store, never returns it, collects and audits", async () => {
  const s = await setup();
  try {
    const created = await s.call<HostView>(
      "POST",
      "",
      s.request({ backupTargetPaths: ["/srv/data/backups/", "/srv/data/backups"] })
    );
    assert.equal(created.status, 200, created.body.error);
    const host = created.body;
    assert.match(host.id, /^host_[0-9a-f]{16}$/);
    assert.equal(host.hasCredential, true);
    assert.deepEqual(host.backupTargetPaths, ["/srv/data/backups"]);
    assert.ok(!JSON.stringify(host).includes("PRIVATE KEY"));
    assert.equal(s.m.secrets.get(`hosts/${host.id}`)?.includes("PRIVATE KEY"), true);
    assert.deepEqual(
      s.m.audit.map((a) => [a.actor, a.action, a.target]),
      [["admin", "hosts.create", host.id]]
    );

    await s.service.settle();
    const fetched = await s.call<HostView>("GET", `/${host.id}`);
    assert.equal(fetched.body.status, "ok");
    assert.equal(fetched.body.detectedKind, "linux");
    assert.equal(fetched.body.facts?.hostname, "box1");
    assert.ok(fetched.body.lastSeenAt);

    const list = await s.call<HostView[]>("GET", "");
    assert.deepEqual(
      list.body.map((h) => h.id),
      [host.id]
    );
    assert.ok(!JSON.stringify(list.body).includes("PRIVATE KEY"));
  } finally {
    await s.close();
  }
});

test("validation: credential required on create, bad keys and addresses refused", async () => {
  const s = await setup();
  try {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ credential: undefined }, /credential: a private key is required/],
      [{ credential: "not a key" }, /credential: The private key could not be read/],
      [{ credential: s.keys.publicKey }, /credential: That is a public key/],
      [{ address: "box; rm -rf /" }, /address/],
      [{ username: "-oProxyCommand=x" }, /username/],
      [{ port: 70000 }, /port/],
      [{ backupTargetPaths: ["relative/path"] }, /backupTargetPaths\.0: Must be an absolute path/],
      [{ hostKeyFingerprint: "md5:aa" }, /hostKeyFingerprint/],
    ];
    for (const [extra, error] of cases) {
      const res = await s.call("POST", "", s.request(extra));
      assert.equal(res.status, 400, JSON.stringify(extra));
      assert.match(res.body.error ?? "", error);
    }
    assert.equal((await s.call<HostView[]>("GET", "")).body.length, 0);
  } finally {
    await s.close();
  }
});

test("viewers can read but not change hosts", async () => {
  const s = await setup();
  try {
    const { body: host } = await s.call<HostView>("POST", "", s.request());
    s.m.setUser(mockViewer);
    assert.equal((await s.call("GET", "")).status, 200);
    assert.equal((await s.call("POST", "", s.request())).status, 403);
    assert.equal((await s.call("PUT", `/${host.id}`, s.request())).status, 403);
    assert.equal((await s.call("DELETE", `/${host.id}`)).status, 403);
    assert.equal((await s.call("POST", "/test", s.request())).status, 403);
  } finally {
    await s.close();
  }
});

test("update keeps the stored key when none is sent, and the pin unless the address moves", async () => {
  const s = await setup();
  try {
    const { body: host } = await s.call<HostView>("POST", "", s.request());
    await s.service.settle();
    const pinned = s.service.store.get(host.id)!.host_key_fingerprint;
    assert.equal(pinned, s.fake.fingerprint);

    const renamed = await s.call<HostView>(
      "PUT",
      `/${host.id}`,
      s.request({ label: "Renamed", credential: undefined })
    );
    assert.equal(renamed.status, 200, renamed.body.error);
    assert.equal(renamed.body.label, "Renamed");
    assert.equal(renamed.body.hasCredential, true);
    assert.equal(s.service.store.get(host.id)!.host_key_fingerprint, pinned);

    const switched = await s.call("PUT", `/${host.id}`, s.request({ auth: "password", credential: undefined }));
    assert.equal(switched.status, 400);

    await s.service.settle();
    const moved = await s.call<HostView>(
      "PUT",
      `/${host.id}`,
      s.request({ address: "localhost", credential: undefined })
    );
    assert.equal(moved.status, 200);
    assert.equal(moved.body.status, "unknown", "state of the old address is cleared");
    await s.service.settle();
    assert.equal(
      s.service.store.get(host.id)!.host_key_fingerprint,
      s.fake.fingerprint,
      "re-pinned on the next connect"
    );

    assert.deepEqual(
      s.m.audit.map((a) => a.action),
      ["hosts.create", "hosts.update", "hosts.update"]
    );
    assert.match(s.m.audit[2]!.detail ?? "", /host key unpinned/);
  } finally {
    await s.close();
  }
});

test("delete removes the host and its secret", async () => {
  const s = await setup();
  try {
    const { body: host } = await s.call<HostView>("POST", "", s.request());
    await s.service.settle();
    assert.deepEqual((await s.call("DELETE", `/${host.id}`)).body, { ok: true });
    assert.equal(s.m.secrets.has(`hosts/${host.id}`), false);
    assert.equal((await s.call("GET", `/${host.id}`)).status, 404);
    assert.equal((await s.call("DELETE", `/${host.id}`)).status, 404);
    assert.equal(s.m.audit.at(-1)!.action, "hosts.delete");
  } finally {
    await s.close();
  }
});

test("test connects with unsaved settings, reports the fingerprint, stores nothing", async () => {
  const s = await setup(truenasHost());
  try {
    const res = await s.call<HostTestResult>("POST", "/test", s.request());
    assert.equal(res.status, 200, res.body.error);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.hostKeyFingerprint, s.fake.fingerprint);
    assert.equal(res.body.detectedKind, "truenas");
    assert.ok(res.body.results.some((r) => r.id === "test.pools" && r.status === "ok"));
    assert.equal((await s.call<HostView[]>("GET", "")).body.length, 0);
    assert.equal(s.m.samples.length, 0);
    assert.equal(s.m.secrets.size, 0);
    assert.deepEqual(
      s.m.audit.map((a) => [a.action, a.result]),
      [["hosts.test", "ok"]]
    );

    const wrongPin = await s.call<HostTestResult>(
      "POST",
      "/test",
      s.request({ hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })
    );
    assert.equal(wrongPin.body.ok, false);
    assert.equal(wrongPin.body.hostKeyFingerprint, s.fake.fingerprint);
    assert.match(wrongPin.body.error ?? "", /Host key changed/);

    const badKey = await s.call<HostTestResult>(
      "POST",
      "/test",
      s.request({ credential: parseableKeyPair().privateKey })
    );
    assert.equal(badKey.body.ok, false);
    assert.equal(badKey.body.results[0]!.status, "crit");

    // A saved host's key stands in for a test of the same endpoint.
    await s.call("POST", "", s.request());
    const reuse = await s.call<HostTestResult>("POST", "/test", s.request({ credential: undefined }));
    assert.equal(reuse.body.ok, true);
    const other = await s.call("POST", "/test", s.request({ credential: undefined, username: "someone" }));
    assert.equal(other.status, 400);
  } finally {
    await s.close();
  }
});

test("registers a health provider in the hosts category", async () => {
  const s = await setup();
  try {
    const provider = s.m.ctx.health.list().find((p) => p.id === "hosts");
    assert.equal(provider?.category, "hosts");
    const { body: host } = await s.call<HostView>("POST", "", s.request());
    await s.service.settle();
    const results = await provider!.collect();
    assert.ok(results.length > 1);
    assert.ok(results.every((r) => r.id.startsWith(`${host.id}.`) && r.label.startsWith("Box: ")));
  } finally {
    await s.close();
  }
});

test("a credential the secret store refuses leaves no host behind", async () => {
  const s = await setup();
  try {
    s.m.ctx.secrets.put = async () => {
      throw new Error("SECRETS_KEY is not set, so secrets cannot be stored or read.");
    };
    const res = await s.call("POST", "", s.request());
    assert.equal(res.status, 503);
    assert.match(res.body.error ?? "", /The credential could not be stored: SECRETS_KEY is not set/);
    assert.equal((await s.call<HostView[]>("GET", "")).body.length, 0);
  } finally {
    await s.close();
  }
});

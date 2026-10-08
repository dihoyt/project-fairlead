import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";
import type { HostKeypair, HostTestResult, HostView } from "../../../src/contracts/hosts.js";
import { createMockContext, mockViewer } from "../../../src/contracts/mocks/context.js";
import hosts, { register } from "../../../src/modules/hosts/index.js";
import { installCommand, KEYPAIR_SCOPE } from "../../../src/modules/hosts/keypair.js";
import { fingerprintOf } from "../../../src/modules/hosts/ssh.js";
import { product } from "../../../src/product.js";
import { startFakeSshHost, type FakeSshHost } from "../../support/index.js";
import { linuxHost, parseableKeyPair } from "./fixtures.js";

const request = (fake: FakeSshHost, extra: Record<string, unknown> = {}) => ({
  label: "Box",
  address: fake.host,
  port: fake.port,
  username: fake.username,
  auth: "key",
  useGeneratedKey: true,
  ...extra,
});

async function setup() {
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
  const fakes: FakeSshHost[] = [];
  const fakeFor = async (publicKey: string) => {
    const fake = await startFakeSshHost({ publicKey, commands: linuxHost() });
    fakes.push(fake);
    return fake;
  };
  return {
    m,
    service,
    call,
    fakeFor,
    request,
    async close() {
      await service.settle();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await m.close();
      for (const fake of fakes) await fake.close();
    },
  };
}

const noPrivate = (value: unknown) => assert.ok(!JSON.stringify(value).includes("PRIVATE KEY"));

test("generates one ed25519 pair per install, returns only the public half, 409 unless rotating", async () => {
  const s = await setup();
  try {
    assert.deepEqual((await s.call("GET", "/keypair")).body, { keypair: null });

    const made = await s.call<HostKeypair>("POST", "/keypair");
    assert.equal(made.status, 200, made.body.error);
    const pair = made.body;
    noPrivate(pair);
    assert.match(pair.publicKey, new RegExp(`^ssh-ed25519 [A-Za-z0-9+/]+=* ${product.slug}$`));
    const parsed = ssh2.utils.parseKey(pair.publicKey);
    assert.ok(!(parsed instanceof Error) && !Array.isArray(parsed));
    assert.equal(pair.fingerprint, fingerprintOf(Buffer.from(pair.publicKey.split(" ")[1]!, "base64")));
    assert.ok(pair.installCommand.includes(pair.publicKey));
    assert.ok(Date.parse(pair.createdAt) > 0);

    const stored = s.m.secrets.get(`${KEYPAIR_SCOPE}/ed25519`);
    assert.ok(stored?.includes("OPENSSH PRIVATE KEY"), "private half sealed in the secret store");

    const read = await s.call<{ keypair: HostKeypair }>("GET", "/keypair");
    assert.deepEqual(read.body.keypair, pair);
    noPrivate(read.body);

    const again = await s.call("POST", "/keypair");
    assert.equal(again.status, 409);
    assert.equal(s.m.secrets.get(`${KEYPAIR_SCOPE}/ed25519`), stored);

    const rotated = await s.call<HostKeypair>("POST", "/keypair?rotate=1");
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.publicKey, pair.publicKey);

    assert.deepEqual(
      s.m.audit.map((a) => [a.action, a.target]),
      [
        ["hosts.generate-keypair", pair.fingerprint],
        ["hosts.rotate-keypair", rotated.body.fingerprint],
      ]
    );
    noPrivate(s.m.audit);
  } finally {
    await s.close();
  }
});

test("viewers can read the public key but not generate one", async () => {
  const s = await setup();
  try {
    s.m.setUser(mockViewer);
    assert.equal((await s.call("GET", "/keypair")).status, 200);
    assert.equal((await s.call("POST", "/keypair")).status, 403);
    assert.equal(s.m.secrets.size, 0);
  } finally {
    await s.close();
  }
});

test("a host using the generated key connects with it and stores no key of its own", async () => {
  const s = await setup();
  try {
    const missing = await s.call("POST", "", s.request(await s.fakeFor(parseableKeyPair().publicKey)));
    assert.equal(missing.status, 400);
    assert.match(missing.body.error ?? "", /generate the key pair first/);

    const { body: pair } = await s.call<HostKeypair>("POST", "/keypair");
    const fake = await s.fakeFor(pair.publicKey);

    const tested = await s.call<HostTestResult>("POST", "/test", s.request(fake));
    assert.equal(tested.body.ok, true, tested.body.error);

    const created = await s.call<HostView>("POST", "", s.request(fake, { credential: "ignored" }));
    assert.equal(created.status, 200, created.body.error);
    assert.equal(created.body.generatedKey, true);
    assert.equal(created.body.hasCredential, true);
    assert.equal(s.m.secrets.has(`hosts/${created.body.id}`), false);
    assert.match(s.m.audit.at(-1)!.detail ?? "", /generated key/);

    await s.service.settle();
    const seen = await s.call<HostView>("GET", `/${created.body.id}`);
    assert.equal(seen.body.status, "ok", seen.body.lastError);
    assert.equal(seen.body.facts?.hostname, "box1");

    // Rotating replaces the key the host trusts, so it stops connecting.
    await s.call("POST", "/keypair?rotate=1");
    await s.service.collectHost(created.body.id);
    const after = await s.call<HostView>("GET", `/${created.body.id}`);
    assert.notEqual(after.body.status, "ok");
  } finally {
    await s.close();
  }
});

test("password auth cannot use the generated key", async () => {
  const s = await setup();
  try {
    await s.call("POST", "/keypair");
    const fake = await s.fakeFor(parseableKeyPair().publicKey);
    const res = await s.call("POST", "", s.request(fake, { auth: "password", credential: "pw" }));
    assert.equal(res.status, 400);
    assert.match(res.body.error ?? "", /useGeneratedKey: only with auth "key"/);
  } finally {
    await s.close();
  }
});

test("switching between the generated key and an own key", async () => {
  const s = await setup();
  try {
    const own = parseableKeyPair();
    const fake = await s.fakeFor(own.publicKey);
    await s.call("POST", "/keypair");

    const { body: host } = await s.call<HostView>(
      "POST",
      "",
      s.request(fake, { useGeneratedKey: false, credential: own.privateKey })
    );
    assert.equal(host.generatedKey, undefined);
    assert.equal(s.m.secrets.has(`hosts/${host.id}`), true);

    const toGenerated = await s.call<HostView>("PUT", `/${host.id}`, s.request(fake));
    assert.equal(toGenerated.status, 200, toGenerated.body.error);
    assert.equal(toGenerated.body.generatedKey, true);
    assert.equal(s.m.secrets.has(`hosts/${host.id}`), false, "the host's own key is removed");
    assert.match(s.m.audit.at(-1)!.detail ?? "", /now the generated key/);

    const noKey = await s.call("PUT", `/${host.id}`, s.request(fake, { useGeneratedKey: false }));
    assert.equal(noKey.status, 400);
    assert.match(noKey.body.error ?? "", /leaving the generated key/);

    const back = await s.call<HostView>(
      "PUT",
      `/${host.id}`,
      s.request(fake, { useGeneratedKey: false, credential: own.privateKey })
    );
    assert.equal(back.status, 200, back.body.error);
    assert.equal(back.body.generatedKey, undefined);
    assert.equal(s.m.secrets.has(`hosts/${host.id}`), true);
    await s.service.settle();
    assert.equal((await s.call<HostView>("GET", `/${host.id}`)).body.status, "ok");
  } finally {
    await s.close();
  }
});

test("the install command adds the key once with sshd's permissions", () => {
  const { publicKey } = parseableKeyPair();
  const line = `${publicKey.trim().split(" ").slice(0, 2).join(" ")} ${product.slug}`;
  const home = mkdtempSync(join(tmpdir(), "keypair-home-"));
  try {
    const command = installCommand(line);
    for (let i = 0; i < 2; i++) execFileSync("sh", ["-c", command], { env: { HOME: home, PATH: process.env.PATH } });
    const file = join(home, ".ssh", "authorized_keys");
    assert.deepEqual(readFileSync(file, "utf8").split("\n").filter(Boolean), [`restrict ${line}`]);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, ".ssh")).mode & 0o777, 0o700);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  assert.throws(() => installCommand("ssh-ed25519 AAAA x'; rm -rf ~; '"), /unexpected public key/);
});

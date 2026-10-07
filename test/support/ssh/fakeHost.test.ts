import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import ssh2 from "ssh2";
import { generateKeyPair, startFakeSshHost, type FakeSshHost } from "./fakeHost.js";

const { Client } = ssh2;

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function exec(
  host: FakeSshHost,
  auth: { password?: string; privateKey?: string },
  command: string,
  pin?: string
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client
      .on("ready", () => {
        client.exec(command, (err, stream) => {
          if (err) return reject(err);
          const out: ExecResult = { stdout: "", stderr: "", code: null };
          stream.on("data", (d: Buffer) => (out.stdout += d));
          stream.stderr.on("data", (d: Buffer) => (out.stderr += d));
          stream.on("close", (code: number) => {
            out.code = code;
            client.end();
            resolve(out);
          });
        });
      })
      .on("error", reject)
      .connect({
        host: host.host,
        port: host.port,
        username: host.username,
        ...auth,
        hostVerifier: pin
          ? (key: Buffer) => `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}` === pin
          : undefined,
      });
  });
}

test("answers canned commands, records them, flags the ones it does not know", async () => {
  const host = await startFakeSshHost({
    password: "pw",
    commands: { "uname -sr": "Linux 6.8.0\n", false: { code: 1, stderr: "nope\n" } },
  });
  try {
    assert.deepEqual(await exec(host, { password: "pw" }, "uname -sr"), {
      stdout: "Linux 6.8.0\n",
      stderr: "",
      code: 0,
    });
    assert.deepEqual(await exec(host, { password: "pw" }, "false"), { stdout: "", stderr: "nope\n", code: 1 });
    const miss = await exec(host, { password: "pw" }, "rm -rf /");
    assert.equal(miss.code, 127);
    assert.deepEqual(host.executed, ["uname -sr", "false", "rm -rf /"]);
    assert.deepEqual(host.unexpected, ["rm -rf /"]);
  } finally {
    await host.close();
  }
});

test("rejects a wrong password and accepts the configured key", async () => {
  const keys = generateKeyPair();
  const host = await startFakeSshHost({ publicKey: keys.publicKey, commands: () => "ok\n" });
  try {
    await assert.rejects(exec(host, { password: "x" }, "id"));
    assert.equal((await exec(host, { privateKey: keys.privateKey }, "id")).stdout, "ok\n");
    assert.ok(host.auth.includes("publickey ok"));
    await assert.rejects(exec(host, { privateKey: generateKeyPair().privateKey }, "id"));
  } finally {
    await host.close();
  }
});

test("exposes the host key fingerprint for pinning, stable across restarts with the same key", async () => {
  const first = await startFakeSshHost({ password: "pw", commands: {} });
  const key = first.hostKey;
  try {
    await exec(first, { password: "pw" }, "id", first.fingerprint);
    await assert.rejects(exec(first, { password: "pw" }, "id", "SHA256:wrong"));
  } finally {
    await first.close();
  }
  const second = await startFakeSshHost({ password: "pw", commands: {}, hostKey: key });
  try {
    assert.equal(second.fingerprint, first.fingerprint);
  } finally {
    await second.close();
  }
});

test("generated keys always parse", () => {
  for (let i = 0; i < 600; i++) {
    const { privateKey, publicKey } = generateKeyPair();
    assert.ok(!(ssh2.utils.parseKey(privateKey) instanceof Error), "private key");
    assert.ok(!(ssh2.utils.parseKey(publicKey) instanceof Error), "public key");
  }
});

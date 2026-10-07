import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer as createTlsServer, type Server } from "node:tls";
import { createServer as createTcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KubeConfig } from "@kubernetes/client-node";
import { createK8sService } from "../../../src/modules/k8s/api.js";
import { serverInfo } from "../../../src/modules/k8s/serverInfo.js";
import { startFakeApi } from "../../support/index.js";

function kubeConfigFor(server: string, extra: Record<string, unknown> = {}): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromString(
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [{ name: "c", cluster: { server, "insecure-skip-tls-verify": true, ...extra } }],
      users: [{ name: "u", user: { token: "t" } }],
      contexts: [{ name: "c", context: { cluster: "c", user: "u" } }],
      "current-context": "c",
    })
  );
  return kc;
}

// A self-signed leaf, as k3s and kubeadm clusters often present to a client
// that doesn't carry their CA.
function selfSigned(days: number) {
  const dir = mkdtempSync(join(tmpdir(), "k8s-cert-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"].concat([
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      String(days),
      "-subj",
      "/O=test/CN=fake-apiserver",
    ]),
    { stdio: "ignore" }
  );
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

async function listen(server: Server | ReturnType<typeof createTcpServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

test("reads the TLS leaf certificate's subject, issuer and expiry, without trusting it", async () => {
  const pair = selfSigned(30);
  const server = createTlsServer(pair, (socket) => socket.end());
  const port = await listen(server);
  try {
    const info = await serverInfo(kubeConfigFor(`https://127.0.0.1:${port}`));
    assert.equal(info.url, `https://127.0.0.1:${port}`);
    assert.equal(info.host, "127.0.0.1");
    assert.ok(info.certificate);
    assert.equal(info.certificate.subject, "fake-apiserver");
    assert.equal(info.certificate.issuer, "fake-apiserver");
    const days = (Date.parse(info.certificate.notAfter) - Date.now()) / 86_400_000;
    assert.ok(days > 29 && days <= 30.01, `notAfter ${info.certificate.notAfter}`);
  } finally {
    server.close();
  }
});

test("a plain-http server has no certificate", async () => {
  const api = await startFakeApi();
  try {
    const conn = { source: "kubeconfig" as const, server: api.url, context: "fake", kubeConfig: api.kubeConfig() };
    const info = await createK8sService({ connection: () => conn }).serverInfo();
    assert.deepEqual(info, { url: api.url, host: "127.0.0.1" });
  } finally {
    await api.close();
  }
});

test("a failed handshake omits the certificate rather than failing", async () => {
  // Accepts and drops the connection, as a non-TLS listener on the port would.
  const server = createTcpServer((socket) => socket.destroy());
  const port = await listen(server);
  try {
    const info = await serverInfo(kubeConfigFor(`https://127.0.0.1:${port}`));
    assert.deepEqual(info, { url: `https://127.0.0.1:${port}`, host: "127.0.0.1" });
  } finally {
    server.close();
  }
});

test("IPv6 hosts lose their brackets; proxied clusters skip the handshake", async () => {
  const v6 = await serverInfo(kubeConfigFor("https://[::1]:1", { "proxy-url": "http://proxy.invalid:3128" }));
  assert.deepEqual(v6, { url: "https://[::1]:1", host: "::1" });
});

test("no connection is an error, which callers report as unknown", async () => {
  const none = createK8sService({ connection: () => ({ source: "none" }) });
  await assert.rejects(none.serverInfo(), /No Kubernetes connection/);
});

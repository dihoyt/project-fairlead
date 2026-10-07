import { isIP } from "node:net";
import tls from "node:tls";
import type { KubeConfig } from "@kubernetes/client-node";
import type { K8sServerInfo } from "../../contracts/k8s.js";

type Certificate = NonNullable<K8sServerInfo["certificate"]>;

// CN when there is one, else the whole DN: "k3s", "O=Acme, OU=Platform".
function dn(name: tls.PeerCertificate["subject"] | undefined): string {
  if (!name) return "";
  const cn = name.CN;
  if (cn) return Array.isArray(cn) ? cn.join(", ") : cn;
  return Object.entries(name)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("+") : value}`)
    .join(", ");
}

// The leaf the API server presents, from a bare TLS handshake. Never
// verified: an expired or untrusted certificate is exactly what the
// expiry check needs to see.
export function readLeafCertificate(
  host: string,
  port: number,
  servername: string | undefined,
  timeoutMs = 10_000
): Promise<Certificate> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername, rejectUnauthorized: false });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`TLS handshake with ${host}:${port} timed out`)));
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.valid_to) return reject(new Error(`${host}:${port} presented no certificate`));
      resolve({ subject: dn(cert.subject), issuer: dn(cert.issuer), notAfter: new Date(cert.valid_to).toISOString() });
    });
  });
}

export async function serverInfo(kc: KubeConfig, log?: (message: string) => void): Promise<K8sServerInfo> {
  const cluster = kc.getCurrentCluster();
  if (!cluster?.server) throw new Error("No cluster in the current kubeconfig context.");
  const url = new URL(cluster.server);
  // URL keeps IPv6 brackets in hostname; a socket wants them off.
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const info: K8sServerInfo = { url: cluster.server, host };
  // Behind a proxy the direct handshake would test the wrong path, if it connected at all.
  if (url.protocol !== "https:" || cluster.proxyUrl) return info;
  const port = url.port ? Number(url.port) : 443;
  const servername = cluster.tlsServerName ?? (isIP(host) ? undefined : host);
  try {
    info.certificate = await readLeafCertificate(host, port, servername);
  } catch (err) {
    log?.(`Could not read the API server certificate: ${err instanceof Error ? err.message : String(err)}`);
  }
  return info;
}

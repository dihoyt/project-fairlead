import http from "node:http";
import https from "node:https";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KubeConfig } from "@kubernetes/client-node";

// Where the cluster connection came from, for the health check's detail.
export type ConnectionSource = "in-cluster" | "kubeconfig" | "none";

export interface Connection {
  source: ConnectionSource;
  // The kubeconfig file, when that is the source.
  file?: string;
  context?: string;
  server?: string;
  kubeConfig?: KubeConfig;
}

const SA_TOKEN = "/var/run/secrets/kubernetes.io/serviceaccount/token";

export interface ConnectionOptions {
  kubeconfig?: string;
  context?: string;
  // Overridable so tests never pick up the developer's own cluster.
  env?: NodeJS.ProcessEnv;
  home?: string;
}

// An explicit kubeconfig wins, then the pod's ServiceAccount, then
// ~/.kube/config. client-node's loadFromDefault is not used because it
// falls back to an invented localhost:8080 cluster when it finds nothing,
// which would read as "API down" rather than "not configured".
export function resolveConnection(options: ConnectionOptions = {}): Connection {
  const env = options.env ?? process.env;
  const kc = new KubeConfig();
  let source: ConnectionSource;
  let file: string | undefined;
  const homeConfig = join(options.home ?? homedir(), ".kube", "config");
  if (options.kubeconfig) {
    file = options.kubeconfig;
    kc.loadFromFile(file);
    source = "kubeconfig";
  } else if (env.KUBERNETES_SERVICE_HOST && existsSync(SA_TOKEN)) {
    kc.loadFromCluster();
    source = "in-cluster";
  } else if (existsSync(homeConfig)) {
    file = homeConfig;
    kc.loadFromFile(file);
    source = "kubeconfig";
  } else {
    return { source: "none" };
  }
  if (options.context) kc.setCurrentContext(options.context);
  const server = kc.getCurrentCluster()?.server;
  if (!server) throw new Error(`The kubeconfig context "${kc.getCurrentContext()}" names no cluster.`);
  return { source, file, context: kc.getCurrentContext(), server, kubeConfig: kc };
}

// A non-2xx answer from the API server, carrying its Status message.
export class K8sError extends Error {
  readonly statusCode: number;
  readonly reason?: string;
  constructor(statusCode: number, message: string, reason?: string) {
    super(message);
    this.name = "K8sError";
    this.statusCode = statusCode;
    this.reason = reason;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  // Socket inactivity, not total duration: a watch may run for minutes as
  // long as events or bookmarks keep arriving.
  idleTimeoutMs?: number;
}

export function buildUrl(server: string, path: string, query: RequestOptions["query"] = {}): URL {
  const url = new URL(server.replace(/\/+$/, "") + path);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

function statusMessage(statusCode: number, body: string): K8sError {
  try {
    const parsed = JSON.parse(body) as { message?: string; reason?: string };
    if (parsed.message) return new K8sError(statusCode, parsed.message, parsed.reason);
  } catch {
    // Not a Status object; fall through to the raw text.
  }
  return new K8sError(statusCode, body.trim().slice(0, 500) || http.STATUS_CODES[statusCode] || "Request failed");
}

// One request through the kubeconfig's TLS and credentials. Uses node's
// http/https with the agent client-node builds, rather than client-node's
// generated clients, so any group/version/plural (CRDs included) and any
// subresource go through the same path. Resolves once headers arrive;
// non-2xx is read in full and thrown as a K8sError.
export async function openRequest(
  kc: KubeConfig,
  path: string,
  options: RequestOptions = {}
): Promise<http.IncomingMessage> {
  const server = kc.getCurrentCluster()?.server;
  if (!server) throw new Error("No cluster in the current kubeconfig context.");
  const url = buildUrl(server, path, options.query);
  const opts: https.RequestOptions = {};
  // Re-applied per request: exec and token-file credentials refresh here.
  await kc.applyToHTTPSOptions(opts);
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: http.OutgoingHttpHeaders = {
    ...(opts.headers as http.OutgoingHttpHeaders | undefined),
    accept: "application/json",
  };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(payload);
  }
  const transport = url.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, { ...opts, method: options.method ?? "GET", headers, signal: options.signal });
    req.setTimeout(options.idleTimeoutMs ?? 30_000, () => req.destroy(new Error(`Timed out: ${url.pathname}`)));
    req.on("error", reject);
    req.on("response", (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 200 && code < 300) return resolve(res);
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => reject(statusMessage(code, text)));
      res.on("error", reject);
    });
    req.end(payload);
  });
}

export async function readBody(res: http.IncomingMessage): Promise<string> {
  let text = "";
  res.setEncoding("utf8");
  for await (const chunk of res) text += chunk as string;
  return text;
}

export async function requestJson<T = unknown>(kc: KubeConfig, path: string, options: RequestOptions = {}): Promise<T> {
  const res = await openRequest(kc, path, options);
  return JSON.parse(await readBody(res)) as T;
}

// Calls onLine for each complete line of a streaming response.
export function readLines(res: http.IncomingMessage, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buffered += chunk;
      let index: number;
      while ((index = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        onLine(line);
      }
    });
    res.on("end", () => {
      if (buffered) onLine(buffered);
      resolve();
    });
    // An aborted stream (stop(), pod gone) ends the read rather than failing it.
    res.on("close", () => resolve());
    res.on("error", (err) => (res.destroyed ? resolve() : reject(err)));
  });
}

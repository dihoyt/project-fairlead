import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KubeConfig } from "@kubernetes/client-node";
import type { KubeObject, ResourceRef } from "../../../src/contracts/k8s.js";
import { loadFixtureSet, type FixtureSet } from "./fixtures.js";

// An HTTP stand-in for a kube-apiserver, read-only like the product: it
// serves a fixture set's lists, gets, watches, discovery, pod logs, kubelet
// stats through the node proxy and SelfSubjectAccessReview, and answers 405
// to every other write. Point @kubernetes/client-node at kubeconfig().

export interface FakeApiOptions {
  fixtures?: FixtureSet;
  // API groups the cluster does not serve (CRD not installed): 404 on every
  // path under them, absent from discovery.
  absentGroups?: string[];
  // Groups or "group/plural" answered with 403 Forbidden (RBAC not granted).
  forbidden?: string[];
  // SelfSubjectAccessReview answers "allowed: false" for "verb group/resource[/sub]".
  denied?: string[];
  // Pod logs by "namespace/pod", merged over the fixture set's.
  logs?: Record<string, string[]>;
  // Required as a bearer token when set.
  token?: string;
}

export interface FakeApi {
  url: string;
  token: string | undefined;
  // Every request received, in order.
  requests: Array<{ method: string; path: string }>;
  kubeconfig(): string;
  kubeConfig(): KubeConfig;
  // Writes a kubeconfig file in a fresh temp dir and returns its path.
  writeKubeconfig(): string;
  upsert(ref: ResourceRef, obj: KubeObject): KubeObject;
  remove(ref: ResourceRef, name: string, namespace?: string): void;
  // Watches asking for a resourceVersion at or below the current one get a
  // 410 Gone, which makes an informer relist.
  expireWatchHistory(): void;
  // Closes every open watch stream; informers reconnect.
  dropWatches(): void;
  close(): Promise<void>;
}

interface Stored {
  ref: ResourceRef;
  items: Map<string, KubeObject>;
  events: Array<{ rv: number; type: "ADDED" | "MODIFIED" | "DELETED"; object: KubeObject }>;
}

interface WatchClient {
  res: ServerResponse;
  store: Stored;
  namespace: string | undefined;
  match(obj: KubeObject): boolean;
}

const keyOf = (ref: ResourceRef) => `${ref.group}/${ref.plural}`;
const objectKey = (obj: KubeObject) => `${obj.metadata.namespace ?? ""}/${obj.metadata.name}`;

function status(res: ServerResponse, code: number, reason: string, message: string, details?: object) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      kind: "Status",
      apiVersion: "v1",
      metadata: {},
      status: "Failure",
      message,
      reason,
      details,
      code,
    })
  );
}

function json(res: ServerResponse, body: unknown) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function fieldValue(obj: unknown, path: string): string | undefined {
  let cur: any = obj;
  for (const part of path.split(".")) cur = cur?.[part];
  return cur === undefined || cur === null ? undefined : String(cur);
}

// Equality, inequality, set-based and existence selectors.
export function matchesLabelSelector(labels: Record<string, string> = {}, selector: string | null): boolean {
  if (!selector) return true;
  const terms = selector.match(/(?:[^,(]|\([^)]*\))+/g) ?? [];
  return terms.every((raw) => {
    const term = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = term.match(/^([^\s!=]+)\s+(in|notin)\s*\(([^)]*)\)$/))) {
      const values = m[3]!.split(",").map((v) => v.trim());
      const key = m[1]!;
      const has = key in labels && values.includes(labels[key]!);
      return m[2] === "in" ? has : !has;
    }
    if ((m = term.match(/^([^\s!=]+)\s*(!=|==|=)\s*(.*)$/))) {
      return m[2] === "!=" ? labels[m[1]!] !== m[3] : labels[m[1]!] === m[3];
    }
    if (term.startsWith("!")) return !(term.slice(1) in labels);
    return term in labels;
  });
}

export function matchesFieldSelector(obj: KubeObject, selector: string | null): boolean {
  if (!selector) return true;
  return selector
    .split(",")
    .filter(Boolean)
    .every((term) => {
      const [, path = "", op = "=", value = ""] = term.match(/^([^!=]+)(!=|==|=)(.*)$/) ?? [];
      const actual = fieldValue(obj, path) ?? "";
      return op === "!=" ? actual !== value : actual === value;
    });
}

export async function startFakeApi(options: FakeApiOptions = {}): Promise<FakeApi> {
  const fixtures = options.fixtures ?? loadFixtureSet();
  const absentGroups = new Set(options.absentGroups ?? []);
  const absentResources = new Set(fixtures.absent.map((a) => `${a.group}/${a.plural}`));
  const forbidden = new Set(options.forbidden ?? []);
  const denied = new Set(options.denied ?? []);
  const logs = { ...fixtures.logs, ...options.logs };
  const stores = new Map<string, Stored>();
  const watchers = new Set<WatchClient>();
  let rv = 1000;
  let historyFloor = 0;
  const requests: FakeApi["requests"] = [];

  const stamp = (obj: KubeObject): KubeObject => ({
    ...obj,
    metadata: { ...obj.metadata, resourceVersion: String(++rv) },
  });
  for (const { ref, items } of fixtures.lists) {
    const store: Stored = { ref, items: new Map(), events: [] };
    for (const item of items) {
      const stored = stamp(item);
      store.items.set(objectKey(stored), stored);
    }
    stores.set(keyOf(ref), store);
  }

  const served = () => [...stores.values()].filter((s) => !isAbsent(s.ref));
  const isAbsent = (ref: ResourceRef) => absentGroups.has(ref.group) || absentResources.has(keyOf(ref));
  const isForbidden = (ref: ResourceRef) => forbidden.has(ref.group) || forbidden.has(keyOf(ref));
  const withKind = (store: Stored, obj: KubeObject): KubeObject => ({
    ...obj,
    apiVersion: store.ref.group ? `${store.ref.group}/${store.ref.version}` : store.ref.version,
    kind: store.ref.kind,
  });

  function notify(store: Stored, type: "ADDED" | "MODIFIED" | "DELETED", object: KubeObject) {
    const event = { rv: Number(object.metadata.resourceVersion), type, object };
    store.events.push(event);
    for (const client of watchers) {
      if (client.store !== store || !client.match(object)) continue;
      client.res.write(JSON.stringify({ type, object: withKind(store, object) }) + "\n");
    }
  }

  function storeFor(ref: ResourceRef): Stored {
    let store = stores.get(keyOf(ref));
    if (!store) {
      store = { ref, items: new Map(), events: [] };
      stores.set(keyOf(ref), store);
    }
    return store;
  }

  function groupVersions(group: string): string[] {
    return [
      ...new Set(
        served()
          .filter((s) => s.ref.group === group)
          .map((s) => s.ref.version)
      ),
    ];
  }

  function resourceList(group: string, version: string) {
    const entries = served().filter((s) => s.ref.group === group && s.ref.version === version);
    const resources = entries.flatMap(({ ref }) => {
      const base = {
        name: ref.plural,
        singularName: ref.kind.toLowerCase(),
        namespaced: ref.namespaced,
        kind: ref.kind,
      };
      const subs =
        keyOf(ref) === "/pods"
          ? [{ name: "pods/log", singularName: "", namespaced: true, kind: "Pod", verbs: ["get"] }]
          : keyOf(ref) === "/nodes"
            ? [{ name: "nodes/proxy", singularName: "", namespaced: false, kind: "Node", verbs: ["get"] }]
            : [];
      return [{ ...base, verbs: ["get", "list", "watch"] }, ...subs];
    });
    return {
      kind: "APIResourceList",
      apiVersion: "v1",
      groupVersion: group ? `${group}/${version}` : version,
      resources,
    };
  }

  function listResponse(store: Stored, matching: KubeObject[]) {
    const { ref } = store;
    return {
      kind: `${ref.kind}List`,
      apiVersion: ref.group ? `${ref.group}/${ref.version}` : ref.version,
      metadata: { resourceVersion: String(rv) },
      // A real API server leaves kind and apiVersion off list items.
      items: matching.map(({ kind: _kind, apiVersion: _apiVersion, ...rest }) => rest),
    };
  }

  function startWatch(
    req: IncomingMessage,
    res: ServerResponse,
    store: Stored,
    url: URL,
    namespace: string | undefined,
    match: (o: KubeObject) => boolean
  ) {
    const since = url.searchParams.get("resourceVersion");
    res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
    res.flushHeaders();
    if (since && Number(since) > 0 && Number(since) < historyFloor) {
      res.write(
        JSON.stringify({
          type: "ERROR",
          object: {
            kind: "Status",
            apiVersion: "v1",
            status: "Failure",
            reason: "Expired",
            code: 410,
            message: "too old resource version",
          },
        }) + "\n"
      );
      res.end();
      return;
    }
    const scoped = (o: KubeObject) => (!namespace || o.metadata.namespace === namespace) && match(o);
    if (since && Number(since) > 0) {
      for (const event of store.events) {
        if (event.rv > Number(since) && scoped(event.object)) {
          res.write(JSON.stringify({ type: event.type, object: withKind(store, event.object) }) + "\n");
        }
      }
    } else {
      for (const obj of store.items.values()) {
        if (scoped(obj)) res.write(JSON.stringify({ type: "ADDED", object: withKind(store, obj) }) + "\n");
      }
    }
    const client: WatchClient = { res, store, namespace, match: scoped };
    watchers.add(client);
    const timeout = Number(url.searchParams.get("timeoutSeconds") ?? 0);
    const timer = timeout > 0 ? setTimeout(() => res.end(), timeout * 1000) : undefined;
    const cleanup = () => {
      watchers.delete(client);
      if (timer) clearTimeout(timer);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  }

  function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;
    requests.push({ method: req.method ?? "GET", path: path + url.search });

    if (options.token && req.headers.authorization !== `Bearer ${options.token}`) {
      return status(res, 401, "Unauthorized", "Unauthorized");
    }
    if (req.method === "POST" && path === "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const attrs = JSON.parse(body || "{}").spec?.resourceAttributes ?? {};
        const group = attrs.group ?? "";
        const resource = `${attrs.resource}${attrs.subresource ? `/${attrs.subresource}` : ""}`;
        const allowed = !absentGroups.has(group) && !denied.has(`${attrs.verb} ${group}/${resource}`);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            kind: "SelfSubjectAccessReview",
            apiVersion: "authorization.k8s.io/v1",
            spec: { resourceAttributes: attrs },
            status: { allowed },
          })
        );
      });
      return;
    }
    if (req.method !== "GET")
      return status(res, 405, "MethodNotAllowed", `fake API is read-only: ${req.method} ${path}`);

    if (path === "/version") {
      return json(
        res,
        fixtures.version ?? { major: "1", minor: "31", gitVersion: "v1.31.4+k3s1", platform: "linux/amd64" }
      );
    }
    if (path === "/api") return json(res, { kind: "APIVersions", versions: ["v1"], serverAddressByClientCIDRs: [] });
    if (path === "/apis") {
      const groups = [
        ...new Set(
          served()
            .map((s) => s.ref.group)
            .filter(Boolean)
        ),
      ].toSorted();
      return json(res, {
        kind: "APIGroupList",
        apiVersion: "v1",
        groups: groups.map((name) => groupObject(name)),
      });
    }
    function groupObject(name: string) {
      const versions = groupVersions(name).map((version) => ({ groupVersion: `${name}/${version}`, version }));
      return { name, versions, preferredVersion: versions[0] };
    }

    const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
    let group: string;
    let version: string;
    let rest: string[];
    if (segments[0] === "api") {
      [group, version, rest] = ["", segments[1] ?? "", segments.slice(2)];
    } else if (segments[0] === "apis") {
      [group, version, rest] = [segments[1] ?? "", segments[2] ?? "", segments.slice(3)];
      if (!version) {
        return groupVersions(group).length
          ? json(res, groupObject(group))
          : status(res, 404, "NotFound", "the server could not find the requested resource");
      }
    } else {
      return status(res, 404, "NotFound", "the server could not find the requested resource");
    }
    if (group && !groupVersions(group).length) {
      return status(res, 404, "NotFound", "the server could not find the requested resource");
    }
    if (rest.length === 0) return json(res, resourceList(group, version));

    let namespace: string | undefined;
    let tail = rest;
    // /namespaces/<ns>/<plural>... is namespace-scoped unless it is the
    // namespaces resource itself.
    if (rest[0] === "namespaces" && rest.length >= 3) {
      namespace = rest[1];
      tail = rest.slice(2);
    }
    const [plural = "", name, sub, ...subRest] = tail;
    const store = stores.get(`${group}/${plural}`);
    if (!store || isAbsent(store.ref) || store.ref.version !== version) {
      return status(res, 404, "NotFound", "the server could not find the requested resource");
    }
    if (isForbidden(store.ref)) {
      return status(
        res,
        403,
        "Forbidden",
        `${plural}${group ? `.${group}` : ""} is forbidden: User cannot ${name ? "get" : "list"} resource "${plural}"`
      );
    }

    const match = (o: KubeObject) =>
      matchesLabelSelector(o.metadata.labels, url.searchParams.get("labelSelector")) &&
      matchesFieldSelector(o, url.searchParams.get("fieldSelector"));
    const inScope = (o: KubeObject) => !namespace || !store.ref.namespaced || o.metadata.namespace === namespace;

    if (!name) {
      if (url.searchParams.get("watch") === "true" || url.searchParams.get("watch") === "1") {
        return startWatch(req, res, store, url, store.ref.namespaced ? namespace : undefined, match);
      }
      return json(
        res,
        listResponse(
          store,
          [...store.items.values()].filter((o) => inScope(o) && match(o))
        )
      );
    }

    const obj = store.items.get(`${store.ref.namespaced ? (namespace ?? "") : ""}/${name}`);
    if (!obj) {
      return status(res, 404, "NotFound", `${plural} "${name}" not found`, { name, kind: plural });
    }
    if (!sub) return json(res, withKind(store, obj));

    if (keyOf(store.ref) === "/pods" && sub === "log") {
      const lines = logs[`${namespace}/${name}`];
      if (!lines) return status(res, 404, "NotFound", `pods "${name}" not found`);
      const tailLines = Number(url.searchParams.get("tailLines") ?? 0);
      const out = tailLines > 0 ? lines.slice(-tailLines) : lines;
      res.writeHead(200, { "content-type": "text/plain" });
      return void res.end(out.length ? out.join("\n") + "\n" : "");
    }
    if (keyOf(store.ref) === "/nodes" && sub === "proxy" && subRest.join("/") === "stats/summary") {
      const summary = fixtures.kubelet[name];
      return summary ? json(res, summary) : status(res, 404, "NotFound", `no kubelet summary for node ${name}`);
    }
    return status(res, 404, "NotFound", "the server could not find the requested resource");
  }

  const server: Server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      status(res, 500, "InternalError", String(err));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // client-node 2.x refuses a plain-http server unless TLS verification is
  // skipped, hence insecure-skip-tls-verify on an http:// cluster.
  const kubeconfig = () =>
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [{ name: "fake", cluster: { server: url, "insecure-skip-tls-verify": true } }],
      users: [{ name: "fake", user: { token: options.token ?? "fake-token" } }],
      contexts: [{ name: "fake", context: { cluster: "fake", user: "fake" } }],
      "current-context": "fake",
    });

  return {
    url,
    token: options.token,
    requests,
    kubeconfig,
    kubeConfig() {
      const config = new KubeConfig();
      config.loadFromString(kubeconfig());
      return config;
    },
    writeKubeconfig() {
      const file = join(mkdtempSync(join(tmpdir(), "fake-k8s-")), "kubeconfig");
      writeFileSync(file, kubeconfig());
      return file;
    },
    upsert(ref, obj) {
      const store = storeFor(ref);
      const key = objectKey(obj);
      const existed = store.items.has(key);
      const stored = stamp(obj);
      store.items.set(key, stored);
      notify(store, existed ? "MODIFIED" : "ADDED", stored);
      return stored;
    },
    remove(ref, name, namespace) {
      const store = storeFor(ref);
      const key = `${namespace ?? ""}/${name}`;
      const gone = store.items.get(key);
      if (!gone) return;
      store.items.delete(key);
      notify(store, "DELETED", stamp(gone));
    },
    expireWatchHistory() {
      historyFloor = ++rv;
      for (const store of stores.values()) store.events.length = 0;
    },
    dropWatches() {
      for (const client of watchers) {
        watchers.delete(client);
        client.res.end();
      }
    },
    async close() {
      for (const client of watchers) client.res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

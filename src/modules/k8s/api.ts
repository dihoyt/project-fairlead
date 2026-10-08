import type { KubeConfig } from "@kubernetes/client-node";
import type {
  Absent,
  AccessCheck,
  CapabilityReport,
  K8sApi,
  K8sServerInfo,
  K8sVersion,
  KubeObject,
  ListOptions,
  LogOptions,
  LogStream,
  ResourceRef,
  Watch,
  WatchHandlers,
} from "../../contracts/k8s.js";
import { AccessReviewer, buildCapabilityReport, unconfiguredReport } from "./access.js";
import { Discovery } from "./discovery.js";
import { InformerPool, listObjects, type InformerTiming } from "./informer.js";
import { isOwned, managedBy, ownedLabels } from "./ownership.js";
import { apiVersionOf, collectionPath, objectPath, withTypeMeta } from "./paths.js";
import { serverInfo } from "./serverInfo.js";
import { K8sError, openRequest, readLines, requestJson, type Connection } from "./transport.js";

export class NotConfiguredError extends Error {
  constructor() {
    super("No Kubernetes connection: not running in a cluster and no kubeconfig found.");
    this.name = "NotConfiguredError";
  }
}

export interface K8sServiceOptions {
  // Called on every operation; a different Connection than last time (the
  // kubeconfig setting changed) drops the discovery and access caches.
  connection: () => Connection;
  timing?: InformerTiming;
  discoveryTtlMs?: number;
  accessTtlMs?: number;
  // How long a capability report is served before it is rebuilt.
  capabilitiesTtlMs?: number;
}

export interface K8sService extends K8sApi {
  serverInfo(): Promise<K8sServerInfo>;
  connection(): Connection;
  close(): Promise<void>;
}

const isNotFound = (err: unknown) => err instanceof K8sError && err.statusCode === 404;

export function createK8sService(options: K8sServiceOptions): K8sService {
  let current: Connection | undefined;
  const connection = () => {
    const next = options.connection();
    if (current && next !== current) {
      discovery.forget();
      reviewer.forget();
      report = undefined;
    }
    current = next;
    return next;
  };
  const kc = (): KubeConfig => {
    const conn = connection();
    if (!conn.kubeConfig) throw new NotConfiguredError();
    return conn.kubeConfig;
  };
  const discovery = new Discovery(kc, options.discoveryTtlMs);
  const reviewer = new AccessReviewer(kc, options.accessTtlMs);
  const pool = new InformerPool(kc, options.timing);
  const capabilitiesTtlMs = options.capabilitiesTtlMs ?? 10 * 60_000;
  let report: { at: number; value: CapabilityReport } | undefined;
  let building: Promise<CapabilityReport> | undefined;

  // A 404 on a collection or object is "absent" only when discovery agrees
  // the resource is not served; otherwise it is a missing object or a real error.
  async function absentAfter(err: unknown, ref: ResourceRef): Promise<boolean> {
    return isNotFound(err) && !(await discovery.served(ref, undefined, true));
  }

  const api: K8sService = {
    connection,

    async list<T extends KubeObject>(ref: ResourceRef, listOptions: ListOptions = {}): Promise<T[] | Absent> {
      if (!(await discovery.served(ref))) return "absent";
      try {
        return (await listObjects<T>(kc(), ref, listOptions)).items;
      } catch (err) {
        if (await absentAfter(err, ref)) return "absent";
        throw err;
      }
    },

    async get<T extends KubeObject>(ref: ResourceRef, name: string, namespace?: string): Promise<T | null | Absent> {
      if (!(await discovery.served(ref))) return "absent";
      try {
        return withTypeMeta(ref, await requestJson<T>(kc(), objectPath(ref, name, namespace)));
      } catch (err) {
        if (!isNotFound(err)) throw err;
        return (await absentAfter(err, ref)) ? "absent" : null;
      }
    },

    async watch<T extends KubeObject>(
      ref: ResourceRef,
      listOptions: ListOptions = {},
      handlers: WatchHandlers<T> = {}
    ): Promise<Watch<T> | Absent> {
      if (!(await discovery.served(ref))) return "absent";
      try {
        return await pool.watch(ref, listOptions, handlers);
      } catch (err) {
        if (await absentAfter(err, ref)) return "absent";
        throw err;
      }
    },

    async create<T extends KubeObject>(ref: ResourceRef, obj: T): Promise<T> {
      const namespace = obj.metadata.namespace;
      if (ref.namespaced && !namespace) {
        throw new Error(`${ref.kind} "${obj.metadata.name}" is namespaced: a namespace is required.`);
      }
      const body = {
        ...obj,
        apiVersion: apiVersionOf(ref),
        kind: ref.kind,
        metadata: { ...obj.metadata, labels: { ...obj.metadata.labels, ...ownedLabels() } },
      };
      const created = await requestJson<T>(kc(), collectionPath(ref, namespace), { method: "POST", body });
      return withTypeMeta(ref, created);
    },

    async delete(ref: ResourceRef, name: string, namespace?: string): Promise<void> {
      try {
        await requestJson(kc(), objectPath(ref, name, namespace), {
          method: "DELETE",
          body: { apiVersion: "v1", kind: "DeleteOptions", propagationPolicy: "Foreground" },
        });
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },

    async raw(path: string): Promise<unknown> {
      if (!path.startsWith("/")) throw new Error(`raw() takes an absolute API path, not "${path}".`);
      return requestJson(kc(), path);
    },

    async logs(namespace, pod, logOptions: LogOptions, onLine): Promise<LogStream> {
      const abort = new AbortController();
      const res = await openRequest(
        kc(),
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log`,
        {
          query: {
            container: logOptions.container,
            tailLines: logOptions.tailLines,
            sinceSeconds: logOptions.sinceSeconds,
            follow: logOptions.follow || undefined,
            timestamps: logOptions.timestamps || undefined,
            previous: logOptions.previous || undefined,
          },
          signal: abort.signal,
          // A followed log can be quiet for a long time.
          idleTimeoutMs: logOptions.follow ? 0 : 30_000,
        }
      );
      const done = readLines(res, (line) => {
        try {
          onLine(line);
        } catch {
          // The consumer's problem; keep reading so done still settles.
        }
      }).catch(() => undefined);
      return {
        done,
        stop: () => {
          abort.abort();
          res.destroy();
        },
      };
    },

    async version(): Promise<K8sVersion> {
      const v = await requestJson<K8sVersion & Record<string, unknown>>(kc(), "/version");
      return {
        major: v.major,
        minor: v.minor,
        gitVersion: v.gitVersion,
        ...(v.platform ? { platform: v.platform } : {}),
      };
    },

    async serverInfo() {
      return serverInfo(kc());
    },

    async capabilities(refresh = false): Promise<CapabilityReport> {
      if (!connection().kubeConfig) return unconfiguredReport();
      if (!refresh && report && Date.now() - report.at < capabilitiesTtlMs) return report.value;
      if (building) return building;
      building = buildCapabilityReport(reviewer, discovery, refresh)
        .then((value) => {
          report = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          building = undefined;
        });
      return building;
    },

    can(check: AccessCheck) {
      return reviewer.can(check);
    },

    managedBy,
    ownedLabels,
    isOwned,

    close() {
      return pool.stopAll();
    },
  };
  return api;
}

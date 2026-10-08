import { RESOURCES, type K8sApi, type KubeObject } from "../../contracts/k8s.js";
import type { NodeSummary, Sample } from "../../contracts/metrics.js";
import { parseQuantity } from "./quantity.js";

export type Source = NodeSummary["source"];

export interface FsStats {
  usedBytes: number;
  capacityBytes: number;
  percent: number;
  inodesPercent?: number;
}

export interface NodeStats {
  name: string;
  ready: boolean;
  source: Source;
  // Why the kubelet's numbers are missing, when they are.
  kubeletError?: string;
  cpuCores?: number;
  cpuPercent?: number;
  memoryBytes?: number;
  memoryPercent?: number;
  fs?: FsStats;
  rxBytesPerSec?: number;
  txBytesPerSec?: number;
  pods: number;
}

export interface ContainerStats {
  namespace: string;
  pod: string;
  container: string;
  node?: string;
  cpuCores?: number;
  memoryBytes?: number;
  restarts?: number;
}

export interface Snapshot {
  at: number;
  nodes: NodeStats[];
  containers: ContainerStats[];
  // Set when the node list itself could not be read.
  error?: string;
}

// The parts of the kubelet Summary API (/stats/summary) read here.
interface Usage {
  time?: string;
  usageNanoCores?: number;
  workingSetBytes?: number;
  availableBytes?: number;
  usedBytes?: number;
  capacityBytes?: number;
  inodes?: number;
  inodesUsed?: number;
  rxBytes?: number;
  txBytes?: number;
}

interface NetworkUsage extends Usage {
  interfaces?: Array<{ name?: string; rxBytes?: number; txBytes?: number }>;
}

interface KubeletSummary {
  node?: { cpu?: Usage; memory?: Usage; fs?: Usage; network?: NetworkUsage };
  pods?: Array<{
    podRef?: { name?: string; namespace?: string };
    containers?: Array<{ name?: string; cpu?: Usage; memory?: Usage }>;
  }>;
}

interface NodeObject extends KubeObject {
  status?: {
    allocatable?: Record<string, string>;
    capacity?: Record<string, string>;
    conditions?: Array<{ type?: string; status?: string }>;
  };
}

interface PodObject extends KubeObject {
  spec?: { nodeName?: string };
  status?: { phase?: string; containerStatuses?: Array<{ name?: string; restartCount?: number }> };
}

interface UsageObject extends KubeObject {
  timestamp?: string;
  usage?: { cpu?: string; memory?: string };
  containers?: Array<{ name?: string; usage?: { cpu?: string; memory?: string } }>;
}

export const summaryPath = (node: string) => `/api/v1/nodes/${encodeURIComponent(node)}/proxy/stats/summary`;

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const percent = (part: number | undefined, whole: number | undefined): number | undefined =>
  part !== undefined && whole ? Math.round((part / whole) * 10_000) / 100 : undefined;

function errorText(err: unknown): string {
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 403) return `forbidden (needs get on nodes/proxy): ${message}`;
  return message;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const isReady = (node: NodeObject) =>
  node.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false;

function allocatable(node: NodeObject, resource: "cpu" | "memory"): number | undefined {
  return parseQuantity(node.status?.allocatable?.[resource]) ?? parseQuantity(node.status?.capacity?.[resource]);
}

function fsStats(fs: Usage | undefined): FsStats | undefined {
  const capacity = num(fs?.capacityBytes);
  if (!capacity) return undefined;
  // Measured from what is available, as the kubelet's eviction thresholds are,
  // so reserved blocks count as used.
  const available = num(fs?.availableBytes);
  const used = available !== undefined ? capacity - available : num(fs?.usedBytes);
  if (used === undefined) return undefined;
  const inodesPercent = percent(num(fs?.inodesUsed), num(fs?.inodes));
  return {
    usedBytes: used,
    capacityBytes: capacity,
    percent: percent(used, capacity)!,
    ...(inodesPercent !== undefined ? { inodesPercent } : {}),
  };
}

const containerKey = (namespace: string, pod: string, container: string) => `${namespace}/${pod}/${container}`;

export interface ScraperOptions {
  now?: () => number;
  kubeletTimeoutMs?: number;
  concurrency?: number;
}

export interface Scraper {
  // A fresh read of the cluster; concurrent callers share one.
  scrape(): Promise<Snapshot>;
  // The last snapshot if it is younger than maxAgeMs, else a fresh one.
  recent(maxAgeMs: number): Promise<Snapshot>;
}

// Reads node and container usage from each node's kubelet Summary API
// through the API server proxy, falling back to metrics-server for nodes
// whose kubelet can't be read. Network counters are turned into rates
// against the previous read of the same node.
export function createScraper(getK8s: () => K8sApi, options: ScraperOptions = {}): Scraper {
  const now = options.now ?? Date.now;
  const kubeletTimeoutMs = options.kubeletTimeoutMs ?? 10_000;
  const concurrency = options.concurrency ?? 8;
  const counters = new Map<string, { at: number; rx: number; tx: number }>();
  let last: Snapshot | undefined;
  let inFlight: Promise<Snapshot> | undefined;

  function rates(node: string, network: NetworkUsage | undefined, fallbackAt: number) {
    const counted = nodeCounters(network);
    if (!counted) return {};
    const { rx, tx } = counted;
    const at = (network?.time && Date.parse(network.time)) || fallbackAt;
    const prev = counters.get(node);
    counters.set(node, { at, rx, tx });
    // The kubelet caches stats for several seconds, and a counter that went
    // backwards means the interface or the node restarted.
    if (!prev || at <= prev.at || rx < prev.rx || tx < prev.tx) return {};
    const seconds = (at - prev.at) / 1000;
    return { rxBytesPerSec: (rx - prev.rx) / seconds, txBytesPerSec: (tx - prev.tx) / seconds };
  }

  async function read(): Promise<Snapshot> {
    const at = now();
    let api: K8sApi;
    let nodes: NodeObject[];
    try {
      api = getK8s();
      const listed = await api.list<NodeObject>(RESOURCES.nodes);
      if (listed === "absent") throw new Error("the API server does not serve nodes");
      nodes = listed;
    } catch (err) {
      return { at, nodes: [], containers: [], error: `Could not list nodes: ${errorText(err)}` };
    }

    const [pods, summaries] = await Promise.all([
      api
        .list<PodObject>(RESOURCES.pods, { fieldSelector: "status.phase!=Succeeded,status.phase!=Failed" })
        .then((list) =>
          list === "absent"
            ? undefined
            : list.filter((p) => p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed")
        )
        .catch(() => undefined),
      mapLimit(nodes, concurrency, async (node) => {
        try {
          const summary = await withTimeout(
            api.raw(summaryPath(node.metadata.name)),
            kubeletTimeoutMs,
            "kubelet summary"
          );
          if (!summary || typeof summary !== "object") throw new Error("kubelet summary is not an object");
          return { summary: summary as KubeletSummary };
        } catch (err) {
          return { error: errorText(err) };
        }
      }),
    ]);

    const fallbackNeeded = summaries.some((s) => !s.summary);
    const listUsage = async (ref: (typeof RESOURCES)["nodeMetrics" | "podMetrics"]) => {
      if (!fallbackNeeded) return undefined;
      const list = await api.list<UsageObject>(ref).catch(() => "absent" as const);
      return list === "absent" ? undefined : list;
    };
    const [nodeMetrics, podMetrics] = await Promise.all([
      listUsage(RESOURCES.nodeMetrics),
      listUsage(RESOURCES.podMetrics),
    ]);

    const podNode = new Map<string, string | undefined>();
    const podsPerNode = new Map<string, number>();
    const containers = new Map<string, ContainerStats>();
    for (const pod of pods ?? []) {
      const namespace = pod.metadata.namespace ?? "";
      const node = pod.spec?.nodeName;
      podNode.set(`${namespace}/${pod.metadata.name}`, node);
      if (node) podsPerNode.set(node, (podsPerNode.get(node) ?? 0) + 1);
      for (const status of pod.status?.containerStatuses ?? []) {
        if (!status.name) continue;
        containers.set(containerKey(namespace, pod.metadata.name, status.name), {
          namespace,
          pod: pod.metadata.name,
          container: status.name,
          ...(node ? { node } : {}),
          ...(num(status.restartCount) !== undefined ? { restarts: status.restartCount } : {}),
        });
      }
    }
    const container = (namespace: string, pod: string, name: string, node: string | undefined) => {
      const key = containerKey(namespace, pod, name);
      let entry = containers.get(key);
      if (!entry) {
        entry = { namespace, pod, container: name, ...(node ? { node } : {}) };
        containers.set(key, entry);
      }
      return entry;
    };

    const nodeStats = nodes.map((node, i): NodeStats => {
      const name = node.metadata.name;
      const cpuAlloc = allocatable(node, "cpu");
      const memAlloc = allocatable(node, "memory");
      const { summary, error } = summaries[i]!;
      const base = { name, ready: isReady(node) };

      if (summary) {
        const cpuNano = num(summary.node?.cpu?.usageNanoCores);
        const cpuCores = cpuNano !== undefined ? cpuNano / 1e9 : undefined;
        const memoryBytes = num(summary.node?.memory?.workingSetBytes);
        for (const pod of summary.pods ?? []) {
          const namespace = pod.podRef?.namespace;
          const podName = pod.podRef?.name;
          if (!namespace || !podName) continue;
          for (const c of pod.containers ?? []) {
            if (!c.name) continue;
            const entry = container(namespace, podName, c.name, name);
            const nano = num(c.cpu?.usageNanoCores);
            if (nano !== undefined) entry.cpuCores = nano / 1e9;
            const ws = num(c.memory?.workingSetBytes);
            if (ws !== undefined) entry.memoryBytes = ws;
          }
        }
        const fs = fsStats(summary.node?.fs);
        return {
          ...base,
          source: "kubelet",
          ...(cpuCores !== undefined ? { cpuCores, cpuPercent: percent(cpuCores, cpuAlloc) } : {}),
          ...(memoryBytes !== undefined ? { memoryBytes, memoryPercent: percent(memoryBytes, memAlloc) } : {}),
          ...(fs ? { fs } : {}),
          ...rates(name, summary.node?.network, at),
          pods: pods ? (podsPerNode.get(name) ?? 0) : (summary.pods?.length ?? 0),
        };
      }

      const metrics = nodeMetrics?.find((m) => m.metadata.name === name);
      const cpuCores = parseQuantity(metrics?.usage?.cpu);
      const memoryBytes = parseQuantity(metrics?.usage?.memory);
      const fromMetricsServer = cpuCores !== undefined || memoryBytes !== undefined;
      return {
        ...base,
        source: fromMetricsServer ? "metrics-server" : "none",
        ...(error ? { kubeletError: error } : {}),
        ...(cpuCores !== undefined ? { cpuCores, cpuPercent: percent(cpuCores, cpuAlloc) } : {}),
        ...(memoryBytes !== undefined ? { memoryBytes, memoryPercent: percent(memoryBytes, memAlloc) } : {}),
        pods: podsPerNode.get(name) ?? 0,
      };
    });

    const fallbackNodes = new Set(nodeStats.filter((n) => n.source !== "kubelet").map((n) => n.name));
    for (const pod of podMetrics ?? []) {
      const namespace = pod.metadata.namespace ?? "";
      const node = podNode.get(`${namespace}/${pod.metadata.name}`);
      if (!node || !fallbackNodes.has(node)) continue;
      for (const c of pod.containers ?? []) {
        if (!c.name) continue;
        const entry = container(namespace, pod.metadata.name, c.name, node);
        const cpu = parseQuantity(c.usage?.cpu);
        if (cpu !== undefined) entry.cpuCores = cpu;
        const memory = parseQuantity(c.usage?.memory);
        if (memory !== undefined) entry.memoryBytes = memory;
      }
    }

    for (const name of counters.keys()) if (!nodes.some((n) => n.metadata.name === name)) counters.delete(name);
    return { at, nodes: nodeStats, containers: [...containers.values()] };
  }

  const scraper: Scraper = {
    scrape() {
      inFlight ??= read()
        .then((snapshot) => {
          last = snapshot;
          return snapshot;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
    async recent(maxAgeMs) {
      if (last && now() - last.at < maxAgeMs) return last;
      return scraper.scrape();
    },
  };
  return scraper;
}

// Pod and overlay interfaces carry traffic that also crosses the node's own
// NICs, so counting them would count it twice.
const VIRTUAL_INTERFACE =
  /^(lo|veth|cni|flannel|cali|tunl|vxlan|docker|br-|virbr|kube-|cilium|lxc|weave|genev|tailscale|wg|vnet|tap|tun|dummy|nodelocaldns)/;

// The kubelet fills the top-level counters only from an interface named
// eth0; on a host whose NIC is called anything else (ens18, enp3s0, ...)
// they are absent and only the per-interface list is set.
export function nodeCounters(network: NetworkUsage | undefined): { rx: number; tx: number } | undefined {
  const rx = num(network?.rxBytes);
  const tx = num(network?.txBytes);
  if (rx !== undefined && tx !== undefined) return { rx, tx };
  let sum: { rx: number; tx: number } | undefined;
  for (const i of network?.interfaces ?? []) {
    const r = num(i.rxBytes);
    const t = num(i.txBytes);
    if (!i.name || VIRTUAL_INTERFACE.test(i.name) || r === undefined || t === undefined) continue;
    sum = { rx: (sum?.rx ?? 0) + r, tx: (sum?.tx ?? 0) + t };
  }
  return sum;
}

export function toSamples(snapshot: Snapshot): Sample[] {
  const samples: Sample[] = [];
  const ts = snapshot.at;
  const add = (series: string, labels: Record<string, string>, value: number | undefined) => {
    if (value !== undefined && Number.isFinite(value)) samples.push({ series, labels, ts, value });
  };
  for (const n of snapshot.nodes) {
    const labels = { node: n.name };
    add("node.cpu.percent", labels, n.cpuPercent);
    add("node.cpu.cores", labels, n.cpuCores);
    add("node.memory.percent", labels, n.memoryPercent);
    add("node.memory.bytes", labels, n.memoryBytes);
    add("node.fs.percent", labels, n.fs?.percent);
    add("node.fs.used.bytes", labels, n.fs?.usedBytes);
    add("node.net.rx.bytesPerSec", labels, n.rxBytesPerSec);
    add("node.net.tx.bytesPerSec", labels, n.txBytesPerSec);
    add("node.pods.count", labels, n.pods);
  }
  for (const c of snapshot.containers) {
    const labels = { namespace: c.namespace, pod: c.pod, container: c.container, ...(c.node ? { node: c.node } : {}) };
    // Percent of one core, as top shows a process: 250 is two and a half cores.
    add("container.cpu.percent", labels, c.cpuCores !== undefined ? Math.round(c.cpuCores * 10_000) / 100 : undefined);
    add("container.memory.bytes", labels, c.memoryBytes);
    add("container.restarts.count", labels, c.restarts);
  }
  return samples;
}

export function toNodeSummaries(snapshot: Snapshot): NodeSummary[] {
  return snapshot.nodes.map((n) => ({
    name: n.name,
    ready: n.ready,
    ...(n.cpuPercent !== undefined ? { cpuPercent: n.cpuPercent } : {}),
    ...(n.memoryPercent !== undefined ? { memoryPercent: n.memoryPercent } : {}),
    pods: n.pods,
    source: n.source,
  }));
}

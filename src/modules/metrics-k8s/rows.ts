import type { HostView } from "../../contracts/hosts.js";
import {
  NODE_SPARK_POINTS,
  NODE_SPARK_WINDOW_MS,
  type NodeSparkMetric,
  type NodeSummary,
} from "../../contracts/metrics.js";
import type { MetricsQuery } from "../../contracts/runtime.js";
import { toNodeSummaries, type Snapshot } from "./scrape.js";

const NODE_SERIES: Record<Exclude<NodeSparkMetric, "load">, string> = {
  cpu: "node.cpu.percent",
  memory: "node.memory.percent",
  filesystem: "node.fs.percent",
  netRx: "node.net.rx.bytesPerSec",
  netTx: "node.net.tx.bytesPerSec",
};

const LOAD_SERIES = "host.load";

const STEP_MS = NODE_SPARK_WINDOW_MS / NODE_SPARK_POINTS;

export interface RowSources {
  hosts: readonly HostView[];
  metrics?: MetricsQuery;
  now: number;
}

const normalize = (address: string) => address.trim().toLowerCase().replace(/\.$/, "");

// A host whose address is one of the node's addresses, or whose short name
// is the node's hostname ("cp-1" for "cp-1.lan").
function matchHost(addresses: readonly string[], hosts: readonly HostView[]): HostView | undefined {
  const own = new Set(addresses.map(normalize));
  return (
    hosts.find((h) => own.has(normalize(h.address))) ??
    hosts.find((h) => {
      const short = normalize(h.address).split(".")[0]!;
      return !/^\d+$/.test(short) && own.has(short);
    })
  );
}

// The store groups points into buckets that start at multiples of the step,
// so the window is laid on those boundaries and each point lands in its own
// slot.
function sparkWindow(now: number) {
  const last = now - (now % STEP_MS);
  const from = last - (NODE_SPARK_POINTS - 1) * STEP_MS;
  return { from, to: now };
}

function toSlots(points: readonly [number, number][], from: number): Array<number | null> | undefined {
  if (points.length === 0) return undefined;
  const slots: Array<number | null> = Array.from({ length: NODE_SPARK_POINTS }, () => null);
  for (const [ts, value] of points) {
    const i = Math.floor((ts - from) / STEP_MS);
    if (i >= 0 && i < NODE_SPARK_POINTS && Number.isFinite(value)) slots[i] = Math.round(value * 100) / 100;
  }
  return slots.some((v) => v !== null) ? slots : undefined;
}

type Sparks = Map<string, Partial<Record<NodeSparkMetric, Array<number | null>>>>;

function querySparks(metrics: MetricsQuery, now: number): { nodes: Sparks; hosts: Sparks } {
  const { from, to } = sparkWindow(now);
  const nodes: Sparks = new Map();
  const hosts: Sparks = new Map();
  const add = (into: Sparks, key: string | undefined, metric: NodeSparkMetric, points: [number, number][]) => {
    if (!key) return;
    const slots = toSlots(points, from);
    if (!slots) return;
    const entry = into.get(key) ?? {};
    entry[metric] = slots;
    into.set(key, entry);
  };
  for (const [metric, series] of Object.entries(NODE_SERIES) as [NodeSparkMetric, string][]) {
    for (const result of metrics.query({ series, from, to, stepMs: STEP_MS })) {
      add(nodes, result.labels.node, metric, result.points);
    }
  }
  for (const result of metrics.query({ series: LOAD_SERIES, from, to, stepMs: STEP_MS })) {
    add(hosts, result.labels.host, "load", result.points);
  }
  return { nodes, hosts };
}

const lastValue = (values: Array<number | null> | undefined) => values?.findLast((v) => v !== null) ?? undefined;

export function toNodeRows(snapshot: Snapshot, sources: RowSources): NodeSummary[] {
  const summaries = toNodeSummaries(snapshot);
  let sparks: { nodes: Sparks; hosts: Sparks } | undefined;
  try {
    sparks = sources.metrics ? querySparks(sources.metrics, sources.now) : undefined;
  } catch {
    // Rows without sparklines beat no rows.
    sparks = undefined;
  }
  return summaries.map((row, i) => {
    const host = matchHost(snapshot.nodes[i]!.addresses, sources.hosts);
    const spark = { ...sparks?.nodes.get(row.name), ...(host ? sparks?.hosts.get(host.id) : undefined) };
    const load1 = lastValue(spark.load);
    const uptime = host?.facts?.uptimeSeconds;
    const seen = host?.lastSeenAt ? Date.parse(host.lastSeenAt) : NaN;
    const hostBoot =
      uptime !== undefined && Number.isFinite(seen) ? new Date(seen - uptime * 1000).toISOString() : undefined;
    return {
      ...row,
      ...(row.bootTime === undefined && hostBoot ? { bootTime: hostBoot } : {}),
      ...(load1 !== undefined ? { load1 } : {}),
      ...(host ? { sshHostId: host.id } : {}),
      ...(Object.keys(spark).length > 0 ? { spark } : {}),
    };
  });
}

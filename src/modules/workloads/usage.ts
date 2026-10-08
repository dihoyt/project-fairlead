import type { SeriesResult } from "../../contracts/metrics.js";
import type { MetricsQuery } from "../../contracts/runtime.js";
import type {
  ClusterUsageReport,
  ContainerUsage,
  NamespaceUsage,
  PodUsage,
  ResourceUsage,
  SpaceUsageReport,
  UsageRange,
  UsageView,
  WorkloadKind,
  WorkloadUsage,
} from "../../contracts/workloads.js";
import { HttpError } from "../../runtime/http.js";
import { topOwner, type Intermediates, type Pod } from "./views.js";

export const USAGE_RANGES: Record<UsageRange, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
};

// The collector scrapes every 30 s; a bucket narrower than a minute would
// leave most buckets empty for every container at once.
const MIN_STEP_MS = 60_000;
const BUCKETS = 120;
// How old the newest sample may be and still count as current.
const CURRENT_MS = 3 * 60_000;
// Samples of one scrape share a timestamp; this absorbs a scrape that
// straddled a few seconds.
const SNAPSHOT_SLACK_MS = 15_000;

export function parseRange(value: unknown): UsageRange {
  if (value === undefined || value === "") return "1h";
  if (typeof value === "string" && value in USAGE_RANGES) return value as UsageRange;
  throw new HttpError(400, `range must be one of ${Object.keys(USAGE_RANGES).join(", ")}.`);
}

// --- Requests and limits ---------------------------------------------------

const DECIMAL: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, "": 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 };
const BINARY: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50 };

export function quantity(text: unknown): number | undefined {
  if (typeof text === "number") return Number.isFinite(text) ? text : undefined;
  if (typeof text !== "string") return undefined;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:([eE][+-]?\d+)|(Ki|Mi|Gi|Ti|Pi|[numkMGTP])?)$/.exec(text.trim());
  if (!match) return undefined;
  const value = Number(match[1] + (match[2] ?? ""));
  const factor = BINARY[match[3] ?? ""] ?? DECIMAL[match[3] ?? ""];
  return factor === undefined || !Number.isFinite(value) ? undefined : value * factor;
}

interface Resources {
  requests?: Record<string, string>;
  limits?: Record<string, string>;
}

type SpecWithResources = { containers?: Array<{ name: string; resources?: Resources }> };

interface Bounds {
  request?: number;
  limit?: number;
}

interface ContainerBounds {
  cpu: Bounds;
  memory: Bounds;
}

function bounds(resources: Resources | undefined, key: "cpu" | "memory"): Bounds {
  const request = quantity(resources?.requests?.[key]);
  const limit = quantity(resources?.limits?.[key]);
  return { ...(request !== undefined ? { request } : {}), ...(limit !== undefined ? { limit } : {}) };
}

// Request: the sum of those set. Limit: only when every part has one.
function sumBounds(parts: Bounds[]): Bounds {
  const requests = parts.flatMap((b) => (b.request !== undefined ? [b.request] : []));
  const limited = parts.length > 0 && parts.every((b) => b.limit !== undefined);
  return {
    ...(requests.length ? { request: requests.reduce((a, b) => a + b, 0) } : {}),
    ...(limited ? { limit: parts.reduce((a, b) => a + b.limit!, 0) } : {}),
  };
}

const isLive = (pod: Pod) => pod.status?.phase !== "Succeeded" && pod.status?.phase !== "Failed";

// --- Samples ---------------------------------------------------------------

type Points = Map<number, number>;

interface Usage {
  cpu: Points;
  memory: Points;
  cpuNow?: number;
  memoryNow?: number;
}

const emptyUsage = (): Usage => ({ cpu: new Map(), memory: new Map() });

function addPoints(into: Points, points: [number, number][], scale: number) {
  for (const [ts, value] of points) into.set(ts, (into.get(ts) ?? 0) + value * scale);
}

function merge(into: Usage, from: Usage) {
  for (const [ts, v] of from.cpu) into.cpu.set(ts, (into.cpu.get(ts) ?? 0) + v);
  for (const [ts, v] of from.memory) into.memory.set(ts, (into.memory.get(ts) ?? 0) + v);
  if (from.cpuNow !== undefined) into.cpuNow = (into.cpuNow ?? 0) + from.cpuNow;
  if (from.memoryNow !== undefined) into.memoryNow = (into.memoryNow ?? 0) + from.memoryNow;
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

function summarise(points: Points, current: number | undefined, b: Bounds, places: number): ResourceUsage {
  const values = [...points.values()];
  return {
    ...(current !== undefined ? { current: round(current, places) } : {}),
    ...(values.length
      ? {
          avg: round(values.reduce((a, v) => a + v, 0) / values.length, places),
          peak: round(Math.max(...values), places),
        }
      : {}),
    ...b,
  };
}

const sorted = (points: Points, places: number): [number, number][] =>
  [...points].toSorted(([a], [b]) => a - b).map(([ts, v]) => [ts, round(v, places)]);

function view(usage: Usage, b: ContainerBounds, withPoints: boolean): UsageView {
  const out: UsageView = {
    cpu: summarise(usage.cpu, usage.cpuNow, b.cpu, 4),
    memory: summarise(usage.memory, usage.memoryNow, b.memory, 0),
  };
  if (withPoints && usage.cpu.size) out.cpuPoints = sorted(usage.cpu, 4);
  if (withPoints && usage.memory.size) out.memoryPoints = sorted(usage.memory, 0);
  return out;
}

// container.cpu.percent is percent of one core.
const SCALE = { cpu: 0.01, memory: 1 } as const;

interface Samples {
  // namespace/pod/container -> usage
  containers: Map<string, Usage & { namespace: string; pod: string; container: string }>;
  collected: boolean;
}

function readSamples(metrics: MetricsQuery | undefined, namespace: string | undefined, from: number, to: number) {
  const samples: Samples = { containers: new Map(), collected: false };
  if (!metrics) return samples;
  const labels = namespace ? { namespace } : undefined;
  const stepMs = Math.max(Math.ceil((to - from) / BUCKETS), MIN_STEP_MS);
  const entry = (r: SeriesResult) => {
    const { namespace: ns = "", pod = "", container = "" } = r.labels;
    const key = `${ns}/${pod}/${container}`;
    let found = samples.containers.get(key);
    if (!found) {
      found = { ...emptyUsage(), namespace: ns, pod, container };
      samples.containers.set(key, found);
    }
    return found;
  };

  for (const resource of ["cpu", "memory"] as const) {
    const series = resource === "cpu" ? "container.cpu.percent" : "container.memory.bytes";
    for (const r of metrics.query({ series, labels, from, to, stepMs })) {
      if (r.points.length === 0) continue;
      samples.collected = true;
      addPoints(entry(r)[resource], r.points, SCALE[resource]);
    }
    // stepMs 1: raw samples, one point per scrape.
    const recent = metrics.query({ series, labels, from: to - CURRENT_MS, to, stepMs: 1 });
    const latest = Math.max(...recent.map((r) => r.points.at(-1)?.[0] ?? -Infinity));
    for (const r of recent) {
      const last = r.points.at(-1);
      if (!last || last[0] < latest - SNAPSHOT_SLACK_MS) continue;
      samples.collected = true;
      entry(r)[resource === "cpu" ? "cpuNow" : "memoryNow"] = last[1] * SCALE[resource];
    }
  }
  return samples;
}

// --- Owners of pods that are gone -------------------------------------------

// The suffix each controller puts after its name when it names a pod. A pod
// that no longer exists can only be traced to its workload by name.
const POD_SUFFIX: Record<WorkloadKind, RegExp> = {
  Deployment: /^[a-z0-9]{1,10}-[a-z0-9]{5}$/,
  StatefulSet: /^\d+$/,
  DaemonSet: /^[a-z0-9]{5}$/,
  Job: /^[a-z0-9]{5}$/,
  CronJob: /^\d+-[a-z0-9]{5}$/,
};

export interface WorkloadRef {
  namespace: string;
  kind: WorkloadKind;
  name: string;
}

export function ownerByName(pod: string, workloads: WorkloadRef[]): string | undefined {
  let best: WorkloadRef | undefined;
  for (const w of workloads) {
    if (!pod.startsWith(`${w.name}-`) || !POD_SUFFIX[w.kind].test(pod.slice(w.name.length + 1))) continue;
    if (!best || w.name.length > best.name.length) best = w;
  }
  return best ? `${best.kind}/${best.name}` : undefined;
}

// --- Reports -----------------------------------------------------------------

export interface UsageInputs {
  pods: Pod[];
  workloads: WorkloadRef[];
  through: Intermediates;
  metrics: MetricsQuery | undefined;
  range: UsageRange;
  now: number;
}

function window(range: UsageRange, now: number) {
  return { range, from: now - USAGE_RANGES[range], to: now };
}

function containerBounds(pod: Pod): Map<string, ContainerBounds> {
  return new Map(
    ((pod.spec as SpecWithResources | undefined)?.containers ?? []).map((c) => [
      c.name,
      { cpu: bounds(c.resources, "cpu"), memory: bounds(c.resources, "memory") },
    ])
  );
}

function totalBounds(parts: ContainerBounds[]): ContainerBounds {
  return { cpu: sumBounds(parts.map((p) => p.cpu)), memory: sumBounds(parts.map((p) => p.memory)) };
}

export function clusterUsage(inputs: UsageInputs): ClusterUsageReport {
  const w = window(inputs.range, inputs.now);
  const samples = readSamples(inputs.metrics, undefined, w.from, w.to);
  const spaces = new Map<string, { usage: Usage; bounds: ContainerBounds[] }>();
  const space = (name: string) => {
    let found = spaces.get(name);
    if (!found) {
      found = { usage: emptyUsage(), bounds: [] };
      spaces.set(name, found);
    }
    return found;
  };
  for (const pod of inputs.pods.filter(isLive)) {
    space(pod.metadata.namespace ?? "").bounds.push(...containerBounds(pod).values());
  }
  for (const c of samples.containers.values()) merge(space(c.namespace).usage, c);
  const namespaces: NamespaceUsage[] = [...spaces]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([namespace, s]) => ({ namespace, ...view(s.usage, totalBounds(s.bounds), true) }));
  return { ...w, collected: samples.collected, namespaces };
}

export function spaceUsage(namespace: string, inputs: UsageInputs): SpaceUsageReport {
  const w = window(inputs.range, inputs.now);
  const samples = readSamples(inputs.metrics, namespace, w.from, w.to);
  const live = inputs.pods
    .filter((p) => p.metadata.namespace === namespace && isLive(p))
    .toSorted((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  const workloadRefs = inputs.workloads.filter((wl) => wl.namespace === namespace);

  const owners = new Map<string, string | undefined>();
  for (const pod of live) owners.set(pod.metadata.name, topOwner(pod, inputs.through));
  const ownerOf = (pod: string) => (owners.has(pod) ? owners.get(pod) : ownerByName(pod, workloadRefs));

  const byPod = new Map<string, Array<Usage & { container: string }>>();
  for (const c of samples.containers.values()) {
    const list = byPod.get(c.pod) ?? [];
    list.push(c);
    byPod.set(c.pod, list);
  }

  const pods: PodUsage[] = live.map((pod) => {
    const per = containerBounds(pod);
    const sampled = byPod.get(pod.metadata.name) ?? [];
    const total = emptyUsage();
    for (const c of sampled) merge(total, c);
    const containers: ContainerUsage[] = [...per].map(([name, b]) => {
      const {
        cpuPoints: _c,
        memoryPoints: _m,
        ...rest
      } = view(sampled.find((c) => c.container === name) ?? emptyUsage(), b, false);
      return { name, ...rest };
    });
    const owner = owners.get(pod.metadata.name);
    return {
      name: pod.metadata.name,
      ...(owner ? { owner } : {}),
      ...view(total, totalBounds([...per.values()]), true),
      containers,
    };
  });

  const workloads: WorkloadUsage[] = workloadRefs.map((ref) => {
    const key = `${ref.kind}/${ref.name}`;
    const usage = emptyUsage();
    for (const [pod, containers] of byPod) {
      if (ownerOf(pod) === key) for (const c of containers) merge(usage, c);
    }
    const mine = live.filter((p) => owners.get(p.metadata.name) === key);
    const b = totalBounds(mine.flatMap((p) => [...containerBounds(p).values()]));
    return { kind: ref.kind, name: ref.name, pods: mine.length, ...view(usage, b, true) };
  });

  return { ...w, collected: samples.collected, workloads, pods };
}

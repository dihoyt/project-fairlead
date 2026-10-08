// Pure data, so the client can import it.
import type { ClusterUsageReport, ResourceUsage, SpaceUsageReport, UsageView } from "../workloads.js";
import { mockValue } from "./metrics.js";
import { HOUR, MOCK_NOW } from "./time.js";

const GiB = 2 ** 30;
const MiB = 2 ** 20;
const STEP = 60_000;

function points(series: string, key: string, scale: number): [number, number][] {
  const out: [number, number][] = [];
  for (let ts = MOCK_NOW - HOUR; ts <= MOCK_NOW; ts += STEP) {
    out.push([ts, Math.round(mockValue(series, { key }, ts) * scale * 1000) / 1000]);
  }
  return out;
}

function summary(values: [number, number][], extra: Pick<ResourceUsage, "request" | "limit">): ResourceUsage {
  const ys = values.map(([, v]) => v);
  return {
    current: ys[ys.length - 1],
    avg: ys.reduce((a, b) => a + b, 0) / ys.length,
    peak: Math.max(...ys),
    ...extra,
  };
}

// CPU in cores from a container.cpu.percent-shaped wave; memory in bytes.
function usage(
  key: string,
  cpuScale: number,
  memScale: number,
  cpu: Pick<ResourceUsage, "request" | "limit">,
  memory: Pick<ResourceUsage, "request" | "limit">
): UsageView {
  const cpuPoints = points("container.cpu.percent", key, cpuScale / 100);
  const memoryPoints = points("container.memory.bytes", key, memScale);
  return { cpu: summary(cpuPoints, cpu), memory: summary(memoryPoints, memory), cpuPoints, memoryPoints };
}

// Over its memory limit at the peak, with a CPU request and no CPU limit.
const jellyfin = usage("jellyfin", 1, 3.2, { request: 0.5 }, { request: 512 * MiB, limit: GiB });
// Requests and limits on everything, comfortably inside them.
const grafana = usage("grafana", 0.4, 0.6, { request: 0.1, limit: 0.5 }, { request: 256 * MiB, limit: 512 * MiB });
// Nothing set at all.
const exporter = usage("node-exporter", 0.2, 0.1, {}, {});

const range = { range: "1h" as const, from: MOCK_NOW - HOUR, to: MOCK_NOW, collected: true };

export const mockClusterUsage: ClusterUsageReport = {
  ...range,
  namespaces: [
    { namespace: "media", ...jellyfin },
    { namespace: "monitoring", ...grafana },
  ],
};

const { cpuPoints: _c, memoryPoints: _m, ...jellyfinContainer } = jellyfin;

export const mockSpaceUsage: SpaceUsageReport = {
  ...range,
  workloads: [
    { kind: "Deployment", name: "jellyfin", pods: 1, ...jellyfin },
    { kind: "DaemonSet", name: "node-exporter", pods: 3, ...exporter },
  ],
  pods: [
    {
      name: "jellyfin-7c9d8",
      owner: "Deployment/jellyfin",
      ...jellyfin,
      containers: [{ name: "jellyfin", ...jellyfinContainer }],
    },
  ],
};

// A cluster with no metrics collected: requests and limits only.
export const mockSpaceUsageUncollected: SpaceUsageReport = {
  ...range,
  collected: false,
  workloads: [
    {
      kind: "Deployment",
      name: "jellyfin",
      pods: 1,
      cpu: { request: 0.5 },
      memory: { request: 512 * MiB, limit: GiB },
    },
  ],
  pods: [
    {
      name: "jellyfin-7c9d8",
      owner: "Deployment/jellyfin",
      cpu: { request: 0.5 },
      memory: { request: 512 * MiB, limit: GiB },
      containers: [{ name: "jellyfin", cpu: { request: 0.5 }, memory: { request: 512 * MiB, limit: GiB } }],
    },
  ],
};

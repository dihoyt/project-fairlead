import type { MetricsCollector, Sample, SeriesQuery, SeriesResult } from "../metrics.js";
import { HOUR, MOCK_NOW } from "./time.js";

export const mockNodes = ["node-1", "node-2", "node-3"];

// Deterministic, plausible values: a daily wave plus a per-series offset.
function wave(ts: number, seed: number, base: number, amplitude: number): number {
  const phase = (ts / (24 * HOUR)) * 2 * Math.PI + seed;
  return Math.round((base + amplitude * Math.sin(phase) + amplitude * 0.2 * Math.sin(phase * 7)) * 100) / 100;
}

function seedOf(text: string): number {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(hash % 1000) / 100;
}

const SERIES_SHAPE: Record<string, { base: number; amplitude: number }> = {
  "node.cpu.percent": { base: 35, amplitude: 20 },
  "node.memory.percent": { base: 60, amplitude: 10 },
  "node.fs.percent": { base: 48, amplitude: 1 },
  "node.net.rx.bytesPerSec": { base: 2_000_000, amplitude: 1_500_000 },
  "container.cpu.percent": { base: 5, amplitude: 4 },
  "container.memory.bytes": { base: 300_000_000, amplitude: 50_000_000 },
  "host.cpu.percent": { base: 15, amplitude: 10 },
  "host.disk.percent": { base: 71, amplitude: 0.5 },
  "host.temp.celsius": { base: 45, amplitude: 6 },
};

export function mockValue(series: string, labels: Record<string, string>, ts: number): number {
  const shape = SERIES_SHAPE[series] ?? { base: 50, amplitude: 25 };
  return wave(ts, seedOf(series + JSON.stringify(labels)), shape.base, shape.amplitude);
}

export function mockSamples(
  series: string,
  labels: Record<string, string>,
  from: number,
  to: number,
  stepMs = 15_000
): Sample[] {
  const samples: Sample[] = [];
  for (let ts = from - (from % stepMs); ts <= to; ts += stepMs) {
    if (ts >= from) samples.push({ series, labels, ts, value: mockValue(series, labels, ts) });
  }
  return samples;
}

// What the metrics query API would answer: node series fan out to one result
// per node unless a node label is given.
export function mockSeries(query: SeriesQuery): SeriesResult[] {
  const step = query.stepMs ?? Math.max(15_000, Math.floor((query.to - query.from) / 240));
  const labelSets =
    query.series.startsWith("node.") && !query.labels?.node
      ? mockNodes.map((node) => ({ ...query.labels, node }))
      : [{ ...query.labels }];
  return labelSets.map((labels) => ({
    series: query.series,
    labels,
    points: mockSamples(query.series, labels, query.from, query.to, step).map(
      (sample) => [sample.ts, sample.value] as [number, number]
    ),
  }));
}

export const mockSeriesResults: SeriesResult[] = mockSeries({
  series: "node.cpu.percent",
  from: MOCK_NOW - HOUR,
  to: MOCK_NOW,
  stepMs: 60_000,
});

export function createMockCollector(id: string, series = "node.cpu.percent", intervalMs = 15_000): MetricsCollector {
  return {
    id,
    intervalMs,
    async collect() {
      const ts = Date.now();
      return mockNodes.map((node) => ({ series, labels: { node }, ts, value: mockValue(series, { node }, ts) }));
    },
  };
}

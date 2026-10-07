export interface Sample {
  // Dotted name with the unit as the last segment when it has one:
  // "node.cpu.percent", "container.memory.bytes", "host.net.rx.bytesPerSec".
  series: string;
  labels: Record<string, string>;
  // Unix milliseconds.
  ts: number;
  value: number;
}

export interface MetricsCollector {
  id: string;
  intervalMs: number;
  // Must not throw; return [] when the source is unreachable and report
  // the reason through a health provider instead.
  collect(): Promise<Sample[]>;
}

export interface SeriesQuery {
  series: string;
  // Exact-match filter; omitted labels match anything, and every matching
  // label set comes back as its own SeriesResult.
  labels?: Record<string, string>;
  from: number;
  to: number;
  // Bucket width. Omitted: the store picks raw, 5-minute or hourly data
  // from the range.
  stepMs?: number;
}

export interface SeriesResult {
  series: string;
  labels: Record<string, string>;
  // [unix ms, value], ascending.
  points: [number, number][];
}

export interface MetricsRegistry {
  addCollector(collector: MetricsCollector): void;
  list(): readonly MetricsCollector[];
  subscribe(onCollector: (collector: MetricsCollector) => void): () => void;
  // Push path, for modules that gather samples outside a collector (the
  // host collector gets metrics and health from one SSH session).
  write(samples: Sample[]): void;
  // The metrics module (A3) installs the store here. Samples written before
  // a sink exists are held, up to a bound, and handed over when it does.
  setSink(sink: (samples: Sample[]) => void): void;
}

// --- HTTP shapes (module "metrics", A3) ----------------------------------

export interface SeriesInfo {
  series: string;
  labelKeys: string[];
  firstTs: number;
  lastTs: number;
}

// --- HTTP shapes (module "metrics-k8s", A11) -----------------------------

export interface NodeSummary {
  name: string;
  ready: boolean;
  cpuPercent?: number;
  memoryPercent?: number;
  pods: number;
  // Where the numbers came from: kubelet Summary API through the API server
  // proxy, metrics-server as the fallback, or nothing available.
  source: "kubelet" | "metrics-server" | "none";
}

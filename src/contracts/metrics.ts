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

// node-role.kubernetes.io/control-plane (or the older master label) makes a
// node "control-plane"; every other node is "worker".
export type NodeRole = "control-plane" | "worker";

// Node conditions that are bad when True.
export type NodePressure = "MemoryPressure" | "DiskPressure" | "PIDPressure";

// The row sparklines. Each is the node's series of the same meaning:
// node.cpu.percent, node.memory.percent, node.fs.percent,
// node.net.rx.bytesPerSec, node.net.tx.bytesPerSec, and host.load for the
// Hosts entry matched to the node.
export type NodeSparkMetric = "cpu" | "memory" | "filesystem" | "netRx" | "netTx" | "load";

// A sparkline covers the last NODE_SPARK_WINDOW_MS in NODE_SPARK_POINTS
// equal buckets (one a minute), oldest first.
export const NODE_SPARK_POINTS = 30;
export const NODE_SPARK_WINDOW_MS = 30 * 60_000;

export interface NodeSummary {
  name: string;
  ready: boolean;
  cpuPercent?: number;
  memoryPercent?: number;
  pods: number;
  // Where the numbers came from: kubelet Summary API through the API server
  // proxy, metrics-server as the fallback, or nothing available.
  source: "kubelet" | "metrics-server" | "none";

  // From the node object.
  roles?: NodeRole[];
  // false when cordoned (spec.unschedulable).
  schedulable?: boolean;
  // The pressure conditions that are True; empty when none is.
  pressure?: NodePressure[];
  // status.nodeInfo.kubeletVersion, "v1.36.1+k3s1".
  kubeletVersion?: string;
  // kubeletVersion's major.minor.patch differs from the API server's.
  versionDrift?: boolean;
  // When the node last came up, ISO 8601: the kubelet summary's
  // node.startTime, else the matched host's uptime. Absent when neither
  // can be read.
  bootTime?: string;
  // status.allocatable.pods (else capacity.pods).
  podCapacity?: number;

  // From the kubelet summary, current values.
  filesystemPercent?: number;
  netRxBps?: number;
  netTxBps?: number;
  // The 1-minute load average of the Hosts entry matched to this node (the
  // kubelet reports none); absent when the node is not a host.
  load1?: number;

  // Longhorn's schedulable space left on this node: storageAvailable minus
  // storageReserved over its schedulable disks, floored at 0. Absent when
  // Longhorn is not installed or has no Node object for it.
  longhornAvailableBytes?: number;
  // The Hosts entry whose address is one of the node's addresses
  // (InternalIP, ExternalIP or Hostname); load1 and bootTime come from it.
  sshHostId?: string;

  // NODE_SPARK_POINTS values per metric, oldest first; null for a bucket
  // with no sample. A metric with no samples in the window is left out.
  spark?: Partial<Record<NodeSparkMetric, Array<number | null>>>;
}

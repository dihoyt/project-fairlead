// Node rows and node actions. Pure data, so the client can import it.
import type { DeployActionPlan, DeployJobView } from "../deploy.js";
import { NODE_SPARK_POINTS, NODE_SPARK_WINDOW_MS, type NodeSparkMetric, type NodeSummary } from "../metrics.js";
import { mockRunningJob } from "./catalog.js";
import { mockValue } from "./metrics.js";
import { DAY, HOUR, MOCK_NOW, isoAgo } from "./time.js";

const SPARK_SERIES: Record<NodeSparkMetric, string> = {
  cpu: "node.cpu.percent",
  memory: "node.memory.percent",
  filesystem: "node.fs.percent",
  netRx: "node.net.rx.bytesPerSec",
  netTx: "node.net.tx.bytesPerSec",
  load: "host.load",
};

// The last NODE_SPARK_WINDOW_MS of the same deterministic series the chart
// mocks draw, so a row and its expanded charts agree.
export function mockNodeSpark(
  node: string,
  metrics: readonly NodeSparkMetric[] = ["cpu", "memory", "filesystem", "netRx", "netTx"],
  hostId?: string
): Partial<Record<NodeSparkMetric, Array<number | null>>> {
  const step = NODE_SPARK_WINDOW_MS / NODE_SPARK_POINTS;
  const spark: Partial<Record<NodeSparkMetric, Array<number | null>>> = {};
  for (const metric of metrics) {
    const labels: Record<string, string> = metric === "load" ? { host: hostId ?? node } : { node };
    spark[metric] = Array.from({ length: NODE_SPARK_POINTS }, (_, i) => {
      const value = mockValue(SPARK_SERIES[metric], labels, MOCK_NOW - NODE_SPARK_WINDOW_MS + (i + 1) * step);
      return metric === "load" ? Math.round(value) / 50 : value;
    });
  }
  return spark;
}

const last = (values: Array<number | null> | undefined) => values?.at(-1) ?? undefined;

const node1Spark = mockNodeSpark("node-1", ["cpu", "memory", "filesystem", "netRx", "netTx", "load"], "h_node1");
const node2Spark = mockNodeSpark("node-2");
// A gap where the kubelet could not be read for three minutes.
node2Spark.cpu = node2Spark.cpu!.map((v, i) => (i >= 20 && i < 23 ? null : v));

// node-1: control plane, matched to a Hosts entry, Longhorn installed.
// node-2: a cordoned worker under disk pressure on an older kubelet.
// node-3: NotReady, nothing read.
export const mockNodeSummaries: NodeSummary[] = [
  {
    name: "node-1",
    ready: true,
    cpuPercent: 41.5,
    memoryPercent: 63.2,
    pods: 34,
    source: "kubelet",
    roles: ["control-plane"],
    schedulable: true,
    pressure: [],
    kubeletVersion: "v1.36.1+k3s1",
    versionDrift: false,
    bootTime: isoAgo(12 * DAY + 3 * HOUR),
    podCapacity: 110,
    filesystemPercent: last(node1Spark.filesystem) ?? 48,
    netRxBps: last(node1Spark.netRx) ?? 2_000_000,
    netTxBps: last(node1Spark.netTx) ?? 600_000,
    load1: last(node1Spark.load) ?? 0.8,
    longhornAvailableBytes: 74_000_000_000,
    sshHostId: "h_node1",
    spark: node1Spark,
  },
  {
    name: "node-2",
    ready: true,
    cpuPercent: 22.1,
    memoryPercent: 58.9,
    pods: 28,
    source: "kubelet",
    roles: ["worker"],
    schedulable: false,
    pressure: ["DiskPressure"],
    kubeletVersion: "v1.35.4+k3s1",
    versionDrift: true,
    bootTime: isoAgo(40 * 60_000),
    podCapacity: 110,
    filesystemPercent: 91.4,
    netRxBps: last(node2Spark.netRx) ?? 1_000_000,
    netTxBps: last(node2Spark.netTx) ?? 300_000,
    longhornAvailableBytes: 3_500_000_000,
    spark: node2Spark,
  },
  {
    name: "node-3",
    ready: false,
    pods: 0,
    source: "none",
    roles: ["worker"],
    schedulable: true,
    pressure: [],
    kubeletVersion: "v1.36.1+k3s1",
    versionDrift: false,
    podCapacity: 110,
  },
];

export const mockDrainPlan: DeployActionPlan = {
  kind: "node-drain",
  title: "Drain node-2",
  allowed: true,
  steps: [
    { label: "Cordon node-2", commands: ["kubectl cordon node-2"] },
    {
      label: "Evict node-2's pods",
      commands: ["kubectl drain node-2 --ignore-daemonsets --timeout=300s"],
    },
  ],
  downtime:
    "Pods on node-2 restart on other nodes; a workload with one replica is down until its pod is running again.",
  rollback: "The node stays cordoned if a step fails; uncordon it to take pods again.",
  changes: [{ kind: "Node", name: "node-2" }],
  creates: [
    { kind: "Job", name: "deploy-node-node-2-12", namespace: "console" },
    { kind: "Secret", name: "deploy-node-node-2-values", namespace: "console" },
  ],
  warnings: ["node-2 runs this console's own pod: it moves to another node and the page reconnects."],
  pods: [
    { namespace: "apps", name: "web-6d4f-x7k2p", owner: "ReplicaSet/web-6d4f", outcome: "evict" },
    {
      namespace: "apps",
      name: "postgres-0",
      owner: "StatefulSet/postgres",
      outcome: "wait",
      reason: "Its PodDisruptionBudget allows no disruption right now; the drain waits for it.",
      pdb: "postgres",
    },
    {
      namespace: "longhorn-system",
      name: "longhorn-manager-q9w2d",
      owner: "DaemonSet/longhorn-manager",
      outcome: "skip",
      reason: "DaemonSet pod, left in place.",
    },
  ],
};

export const mockCordonPlan: DeployActionPlan = {
  kind: "node-cordon",
  title: "Cordon node-1",
  allowed: true,
  steps: [{ label: "Cordon node-1", commands: ["kubectl cordon node-1"] }],
  changes: [{ kind: "Node", name: "node-1" }],
  creates: [
    { kind: "Job", name: "deploy-node-node-1-11", namespace: "console" },
    { kind: "Secret", name: "deploy-node-node-1-values", namespace: "console" },
  ],
  warnings: [],
};

export const mockRebootBlockedPlan: DeployActionPlan = {
  kind: "node-reboot",
  title: "Reboot node-1",
  allowed: false,
  blockedBy: "node-1 is the only node; draining it would leave nothing to run its pods.",
  steps: [],
  changes: [],
  creates: [],
  warnings: [],
};

export const mockDrainJob: DeployJobView = {
  ...mockRunningJob,
  id: "dj_12",
  appId: "node-node-2",
  release: "node-node-2",
  namespace: "console",
  mode: "action",
  action: "node-drain",
  job: { namespace: "console", name: "deploy-node-node-2-12" },
};

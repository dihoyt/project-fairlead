import type { CheckResult, Status } from "../../contracts/health.js";
import type { NodeStats, Snapshot } from "./scrape.js";

export interface Thresholds {
  memoryWarnPercent: number;
  memoryCritPercent: number;
  diskWarnPercent: number;
  diskCritPercent: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  memoryWarnPercent: 85,
  memoryCritPercent: 95,
  // The kubelet's default hard eviction starts at 10% of nodefs available.
  diskWarnPercent: 80,
  diskCritPercent: 90,
};

const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GiB`;
const pct = (value: number) => `${value.toFixed(1)}%`;

function grade(value: number, warn: number, crit: number): Status {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function missing(node: NodeStats): string {
  if (!node.ready) return `${node.name} is not Ready, so it reports no usage`;
  if (node.kubeletError) return `No usage data for ${node.name}: ${node.kubeletError}`;
  return `No usage data for ${node.name}`;
}

function memoryCheck(node: NodeStats, t: Thresholds, observedAt: string): CheckResult {
  const base = {
    id: `memory:${node.name}`,
    label: `Memory on ${node.name}`,
    object: { kind: "Node", name: node.name },
    observedAt,
  };
  if (node.memoryPercent === undefined) {
    return { ...base, status: "unknown", detail: missing(node), raw: { node: node.name, source: node.source } };
  }
  const status = grade(node.memoryPercent, t.memoryWarnPercent, t.memoryCritPercent);
  const used = node.memoryBytes !== undefined ? ` (${gib(node.memoryBytes)} working set)` : "";
  return {
    ...base,
    status,
    value: node.memoryPercent,
    detail: `${pct(node.memoryPercent)} of allocatable memory in use${used}`,
    ...(status !== "ok"
      ? {
          raw: {
            node: node.name,
            source: node.source,
            memoryPercent: node.memoryPercent,
            workingSetBytes: node.memoryBytes,
            warnPercent: t.memoryWarnPercent,
            critPercent: t.memoryCritPercent,
          },
        }
      : {}),
  };
}

function diskCheck(node: NodeStats, t: Thresholds, observedAt: string): CheckResult {
  const base = {
    id: `disk:${node.name}`,
    label: `Disk on ${node.name}`,
    object: { kind: "Node", name: node.name },
    observedAt,
  };
  if (!node.fs) {
    // metrics-server has no filesystem figures; without nodes/proxy this
    // check can't exist, which is a choice of the install, not a fault.
    if (node.source === "metrics-server") {
      return {
        ...base,
        status: "absent",
        detail: `Filesystem usage needs the kubelet stats (get on nodes/proxy); ${node.name} is read through metrics-server`,
      };
    }
    return { ...base, status: "unknown", detail: missing(node), raw: { node: node.name, source: node.source } };
  }
  const { fs } = node;
  const inodesWorse = fs.inodesPercent !== undefined && fs.inodesPercent > fs.percent;
  const value = inodesWorse ? fs.inodesPercent! : fs.percent;
  const status = grade(value, t.diskWarnPercent, t.diskCritPercent);
  const detail =
    `${pct(fs.percent)} of the node filesystem used (${gib(fs.usedBytes)} of ${gib(fs.capacityBytes)})` +
    (inodesWorse ? `, ${pct(fs.inodesPercent!)} of inodes` : "");
  return {
    ...base,
    status,
    value,
    detail,
    ...(status !== "ok"
      ? { raw: { node: node.name, fs, warnPercent: t.diskWarnPercent, critPercent: t.diskCritPercent } }
      : {}),
  };
}

function collectionCheck(snapshot: Snapshot, observedAt: string): CheckResult {
  const base = { id: "collection", label: "Node usage data", observedAt };
  if (snapshot.error) return { ...base, status: "unknown", detail: snapshot.error, raw: { error: snapshot.error } };
  if (snapshot.nodes.length === 0) return { ...base, status: "unknown", detail: "The cluster reported no nodes" };

  const ready = snapshot.nodes.filter((n) => n.ready);
  const by = (source: NodeStats["source"]) => ready.filter((n) => n.source === source);
  const kubelet = by("kubelet");
  const fallback = by("metrics-server");
  const none = by("none");
  const failures = [...fallback, ...none].map((n) => ({
    node: n.name,
    source: n.source,
    kubeletError: n.kubeletError,
  }));

  if (none.length > 0) {
    return {
      ...base,
      status: "warn",
      value: none.length,
      detail: `No usage data for ${none.map((n) => n.name).join(", ")}: the kubelet stats can't be read and metrics-server has nothing for ${none.length === 1 ? "it" : "them"}`,
      raw: failures,
    };
  }
  if (fallback.length > 0) {
    const reason = fallback[0]!.kubeletError ? ` (kubelet: ${fallback[0]!.kubeletError})` : "";
    return {
      ...base,
      status: "ok",
      detail: `${kubelet.length} of ${ready.length} Ready nodes via the kubelet, ${fallback.length} via metrics-server${reason}`,
      raw: failures,
    };
  }
  return { ...base, status: "ok", detail: `${kubelet.length} of ${ready.length} Ready nodes via the kubelet` };
}

export function judge(snapshot: Snapshot, thresholds: Thresholds): CheckResult[] {
  const observedAt = new Date(snapshot.at).toISOString();
  return [
    collectionCheck(snapshot, observedAt),
    ...snapshot.nodes.flatMap((node) => [
      memoryCheck(node, thresholds, observedAt),
      diskCheck(node, thresholds, observedAt),
    ]),
  ];
}

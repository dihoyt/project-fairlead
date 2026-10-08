import type { LonghornReplicaAdvice, LonghornReplicaVolume } from "../../contracts/backups.js";
import type { CheckResult } from "../../contracts/health.js";
import type { KubeObject } from "../../contracts/k8s.js";
import { errorMessage } from "../../runtime/log.js";
import { readable, type LonghornNode, type Snapshot } from "./model.js";

// A second copy on another node is what protects against losing one; more
// than that costs disk on every node for little, so the advice stops at 2.
export const REPLICA_TARGET = 2;
export const LONGHORN_PROVISIONER = "driver.longhorn.io";
export const REPLICA_SETTING = "default-replica-count";

export interface StorageClassObject extends KubeObject {
  provisioner?: string;
  parameters?: Record<string, string>;
}

const whole = (value: unknown): number | undefined => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

// Longhorn 1.10 made some settings per data engine, written as JSON
// ({"v1":"2","v2":"2"}); a plain value still applies to every engine. The
// lowest engine's count is the one that matters.
export function replicaCount(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const counts = Object.values(JSON.parse(value) as Record<string, unknown>).map(whole);
      return counts.every((n) => n !== undefined) && counts.length > 0 ? Math.min(...(counts as number[])) : undefined;
    } catch {
      return undefined;
    }
  }
  return whole(value);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function schedulable(node: LonghornNode): boolean {
  const ready = node.status?.conditions?.find((c) => c.type === "Ready");
  return node.spec?.allowScheduling !== false && ready?.status === "True";
}

function describe(advice: Omit<LonghornReplicaAdvice, "detail" | "checkedAt">): string {
  const { schedulableNodes: nodes, target } = advice;
  if (nodes < 2) {
    return `${plural(nodes, "schedulable node")}: 1 replica is all it can hold.`;
  }
  if (advice.state === "ok") return `Every volume has ${target} or more replicas across ${plural(nodes, "node")}.`;
  const can = `${plural(nodes, "node")} can hold ${target}.`;
  if (advice.volumes.length > 0) {
    const fewest = advice.volumes[0]!.replicas;
    const same = advice.volumes.every((v) => v.replicas === fewest);
    const have = same ? `${plural(fewest, "replica")}` : `fewer than ${target} replicas`;
    return `${plural(advice.volumes.length, "volume")} ${advice.volumes.length === 1 ? "has" : "have"} ${have}; ${can}`;
  }
  const lowest = Math.min(advice.defaultReplicaCount ?? target, ...advice.storageClasses.map((sc) => sc.replicas));
  return `New volumes get ${plural(lowest, "replica")}; ${can}`;
}

export function unreadableAdvice(error: string, checkedAt: string): LonghornReplicaAdvice {
  return {
    state: "unknown",
    schedulableNodes: 0,
    target: 0,
    storageClasses: [],
    volumes: [],
    detail: `Could not read Longhorn: ${error}`,
    error,
    checkedAt,
  };
}

export function replicaAdvice(
  snapshot: Snapshot | "absent",
  storageClasses: readonly StorageClassObject[],
  checkedAt: string
): LonghornReplicaAdvice {
  const empty = { schedulableNodes: 0, target: 0, storageClasses: [], volumes: [], checkedAt };
  if (snapshot === "absent") return { ...empty, state: "absent", detail: "Longhorn is not installed in this cluster." };
  const nodes = readable(snapshot.nodes);
  if (!nodes) {
    const error = (snapshot.nodes as { error: string }).error;
    return { ...empty, state: "unknown", detail: `Could not read Longhorn's nodes: ${error}`, error };
  }
  const schedulableNodes = nodes.filter(schedulable).length;
  const target = Math.min(REPLICA_TARGET, schedulableNodes);
  const setting = snapshot.settings.find((s) => s.metadata.name === REPLICA_SETTING);
  const defaultReplicaCount = replicaCount(setting?.value);

  const classes = storageClasses
    .filter((sc) => sc.provisioner === LONGHORN_PROVISIONER)
    .map((sc) => ({ name: sc.metadata.name, replicas: replicaCount(sc.parameters?.numberOfReplicas) }))
    .filter((sc): sc is { name: string; replicas: number } => sc.replicas !== undefined && sc.replicas < target)
    .toSorted((a, b) => a.name.localeCompare(b.name));

  const volumes: LonghornReplicaVolume[] = [];
  for (const v of snapshot.volumes) {
    const replicas = replicaCount(v.spec?.numberOfReplicas);
    if (replicas === undefined || replicas >= target) continue;
    const k = v.status?.kubernetesStatus;
    volumes.push({
      name: v.metadata.name,
      replicas,
      ...(k?.pvcName && k.namespace ? { pvc: { namespace: k.namespace, name: k.pvcName } } : {}),
    });
  }
  volumes.sort((a, b) => a.replicas - b.replicas || a.name.localeCompare(b.name));

  const below =
    (defaultReplicaCount !== undefined && defaultReplicaCount < target) || classes.length > 0 || volumes.length > 0;
  const advice = {
    state: target >= 2 && below ? ("raise" as const) : ("ok" as const),
    schedulableNodes,
    target,
    ...(defaultReplicaCount !== undefined ? { defaultReplicaCount } : {}),
    storageClasses: target >= 2 ? classes : [],
    volumes: target >= 2 ? volumes : [],
  };
  return { ...advice, detail: describe(advice), checkedAt };
}

export function replicaResult(advice: LonghornReplicaAdvice, observedAt: string): CheckResult {
  return {
    id: "replica-target",
    label: "Replica count",
    status: advice.state === "raise" ? "warn" : advice.state,
    ...(advice.target > 0 ? { value: advice.target } : {}),
    detail:
      advice.state === "raise" ? `${advice.detail} Raise it from the Nodes page or the health board.` : advice.detail,
    ...(advice.state === "raise" || advice.state === "unknown"
      ? {
          raw: {
            defaultReplicaCount: advice.defaultReplicaCount,
            storageClasses: advice.storageClasses,
            volumes: advice.volumes,
            ...(advice.error ? { error: advice.error } : {}),
          },
        }
      : {}),
    observedAt,
  };
}

// StorageClasses are cluster-scoped and may be unreadable on an older
// chart; the advice then leaves them out rather than failing.
export async function readStorageClasses(
  list: () => Promise<StorageClassObject[] | "absent">,
  warn: (message: string, meta: Record<string, unknown>) => void
): Promise<StorageClassObject[]> {
  try {
    const found = await list();
    return found === "absent" ? [] : found;
  } catch (err) {
    warn("Could not read StorageClasses for the replica advice", { error: errorMessage(err) });
    return [];
  }
}

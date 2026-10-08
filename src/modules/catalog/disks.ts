import type { NodeDisk } from "../../contracts/catalog.js";
import { RESOURCES, type K8sApi, type KubeObject } from "../../contracts/k8s.js";

interface Node extends KubeObject {
  spec?: { unschedulable?: boolean };
  status?: { conditions?: Array<{ type?: string; status?: string }> };
}

interface FsStats {
  availableBytes?: number;
  capacityBytes?: number;
}

interface Summary {
  node?: { fs?: FsStats; runtime?: { imageFs?: FsStats } };
}

// A kubelet that stopped answering would otherwise hold up all of discovery.
const SUMMARY_TIMEOUT_MS = 5_000;

const bytes = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const ready = (node: Node) => node.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function reason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/forbidden|403/i.test(text)) return "forbidden: needs get on nodes/proxy";
  return text.split("\n")[0]!.slice(0, 120);
}

async function nodeDisk(k8s: K8sApi, node: Node, timeoutMs: number): Promise<NodeDisk> {
  const name = node.metadata.name;
  if (!ready(node)) return { node: name, error: "node not ready" };
  try {
    const summary = (await withTimeout(
      k8s.raw(`/api/v1/nodes/${encodeURIComponent(name)}/proxy/stats/summary`),
      timeoutMs
    )) as Summary;
    const fs = summary.node?.fs;
    const imageFs = summary.node?.runtime?.imageFs;
    const availableBytes = bytes(fs?.availableBytes);
    const capacityBytes = bytes(fs?.capacityBytes);
    if (availableBytes === undefined || capacityBytes === undefined) {
      return { node: name, error: "the kubelet reported no filesystem stats" };
    }
    const imageAvailableBytes = bytes(imageFs?.availableBytes);
    const imageCapacityBytes = bytes(imageFs?.capacityBytes);
    return {
      node: name,
      availableBytes,
      capacityBytes,
      ...(imageAvailableBytes !== undefined && imageCapacityBytes !== undefined
        ? { imageAvailableBytes, imageCapacityBytes }
        : {}),
    };
  } catch (err) {
    return { node: name, error: reason(err) };
  }
}

// Free disk on every schedulable node; undefined when the nodes can't be listed.
export async function nodeDisks(k8s: K8sApi, timeoutMs = SUMMARY_TIMEOUT_MS): Promise<NodeDisk[] | undefined> {
  let nodes: Node[] | "absent";
  try {
    nodes = await k8s.list<Node>(RESOURCES.nodes);
  } catch {
    return undefined;
  }
  if (nodes === "absent") return undefined;
  const schedulable = nodes.filter((node) => !node.spec?.unschedulable);
  return Promise.all(schedulable.map((node) => nodeDisk(k8s, node, timeoutMs)));
}

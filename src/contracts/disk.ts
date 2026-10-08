// The disk-space preflight for a deploy: what the apps that would run take,
// against what the nodes have free. Pure, so the client can import it.

import type { DiskFootprint, NodeDisk } from "./catalog.js";
import type { Status } from "./health.js";

export interface DiskCheck {
  // ok: fits with room to spare. warn: fits, but less than HEADROOM of the
  // disk would stay free. crit: needs more than is free (the plan is
  // blocked). unknown: no node's free space could be read (not blocked).
  status: Status;
  volumeBytes: number;
  imageBytes: number;
  // Summed over the nodes that could be read.
  availableBytes?: number;
  capacityBytes?: number;
  nodesRead: number;
  nodesTotal: number;
  // One or two sentences: what is needed, what is free, what is left.
  detail: string;
}

// The kubelet starts garbage-collecting images at 85% use and evicting pods
// at 90% by default, so a disk left under 20% free is close to both.
export const DISK_HEADROOM = 0.2;

const GiB = 1024 ** 3;

export function formatBytes(bytes: number): string {
  if (bytes >= GiB) return `${(bytes / GiB).toFixed(1).replace(/\.0$/, "")} GiB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MiB`;
}

const readable = (d: NodeDisk): d is NodeDisk & { availableBytes: number; capacityBytes: number } =>
  d.availableBytes !== undefined && d.capacityBytes !== undefined && d.capacityBytes > 0;

const separateImageFs = (d: NodeDisk): boolean =>
  d.imageAvailableBytes !== undefined &&
  d.imageCapacityBytes !== undefined &&
  d.imageCapacityBytes > 0 &&
  d.imageCapacityBytes !== d.capacityBytes;

function judge(need: number, available: number, capacity: number): Status {
  if (need > available) return "crit";
  return available - need < capacity * DISK_HEADROOM ? "warn" : "ok";
}

const worst = (a: Status, b: Status): Status => {
  const rank: Status[] = ["ok", "unknown", "warn", "crit"];
  return rank.indexOf(a) >= rank.indexOf(b) ? a : b;
};

// Sums every footprint and every readable node. Volumes and images share a
// node's root filesystem unless every node reports a separate image
// filesystem. Treating the nodes as one pool is a lower bound on what a
// single node needs; with one node, the usual first install, it is exact.
export function checkDisk(footprints: readonly DiskFootprint[], disks: readonly NodeDisk[] | undefined): DiskCheck {
  const volumeBytes = footprints.reduce((sum, f) => sum + f.volumeBytes, 0);
  const imageBytes = footprints.reduce((sum, f) => sum + f.imageBytes, 0);
  const all = disks ?? [];
  const nodes = all.filter(readable);
  const needs = `Needs about ${formatBytes(volumeBytes + imageBytes)} of disk (${formatBytes(volumeBytes)} of volumes, ${formatBytes(imageBytes)} of images)`;
  const base = { volumeBytes, imageBytes, nodesRead: nodes.length, nodesTotal: all.length };

  if (nodes.length === 0) {
    const why = all.find((d) => d.error)?.error;
    return {
      ...base,
      status: "unknown",
      detail: `${needs}; the nodes' free space couldn't be read${why ? ` (${why})` : ""}.`,
    };
  }

  const availableBytes = nodes.reduce((sum, d) => sum + d.availableBytes, 0);
  const capacityBytes = nodes.reduce((sum, d) => sum + d.capacityBytes, 0);
  const imagesApart = nodes.every(separateImageFs);
  const fsNeed = volumeBytes + (imagesApart ? 0 : imageBytes);
  let status = judge(fsNeed, availableBytes, capacityBytes);
  let imageNote = "";
  if (imagesApart) {
    const imageAvailable = nodes.reduce((sum, d) => sum + (d.imageAvailableBytes ?? 0), 0);
    const imageCapacity = nodes.reduce((sum, d) => sum + (d.imageCapacityBytes ?? 0), 0);
    status = worst(status, judge(imageBytes, imageAvailable, imageCapacity));
    imageNote = ` Images go to a separate disk with ${formatBytes(imageAvailable)} free.`;
  }

  const where =
    nodes.length === 1
      ? `the node has ${formatBytes(availableBytes)} free of ${formatBytes(capacityBytes)}`
      : `the ${nodes.length} nodes have ${formatBytes(availableBytes)} free of ${formatBytes(capacityBytes)} between them`;
  const unread =
    all.length > nodes.length ? ` ${all.length - nodes.length} of ${all.length} nodes couldn't be read.` : "";
  const left = availableBytes - fsNeed;
  const outcome =
    status === "crit"
      ? left < 0
        ? ` That is ${formatBytes(-left)} short: free some space or add disk before rolling out.`
        : " The image disk is too small: free some space or add disk before rolling out."
      : status === "warn"
        ? ` That leaves ${Math.max(0, Math.round((left / capacityBytes) * 100))}% free, close to where Kubernetes starts evicting pods.`
        : "";

  return {
    ...base,
    status,
    availableBytes,
    capacityBytes,
    detail: `${needs}; ${where}.${outcome}${imageNote}${unread}`,
  };
}

import type { HostKind, HostView } from "@contracts/hosts";
import { formatValue } from "../../ui";

export const KIND_LABEL: Record<HostKind, string> = {
  auto: "Detect automatically",
  linux: "Linux",
  synology: "Synology DSM",
  truenas: "TrueNAS SCALE",
};

export function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  if (days > 0) return `up ${days}d`;
  const hours = Math.floor(seconds / 3600);
  return hours > 0 ? `up ${hours}h` : `up ${Math.floor(seconds / 60)}m`;
}

// One line for a host's tile: what is wrong, else what it is.
export function hostSummary(host: HostView): string {
  if (host.lastError) return host.lastError;
  if (!host.lastSeenAt) return host.hasCredential ? "Waiting for the first collection" : "No credential stored";
  const facts = host.facts ?? {};
  return [
    facts.os ?? (host.detectedKind ? KIND_LABEL[host.detectedKind] : undefined),
    facts.cpus ? `${facts.cpus} CPU` : undefined,
    facts.memoryBytes ? formatValue(facts.memoryBytes, "bytes") : undefined,
    facts.uptimeSeconds !== undefined ? uptime(facts.uptimeSeconds) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

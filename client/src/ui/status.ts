import { STATUS_SEVERITY } from "@contracts/health";
import type { Status } from "./contracts";

export const STATUS_COLOR: Record<Status, string> = {
  ok: "teal",
  warn: "yellow",
  crit: "red",
  unknown: "gray",
  absent: "gray",
};

export const STATUS_LABEL: Record<Status, string> = {
  ok: "OK",
  warn: "Warning",
  crit: "Critical",
  unknown: "Unknown",
  absent: "Not installed",
};

// The roll-up rule from the health contract: the worst member wins, and
// "absent" never makes a group look worse than "ok".
export function worstStatus(statuses: Iterable<Status>): Status {
  let worst = STATUS_SEVERITY.length - 1;
  for (const status of statuses) worst = Math.min(worst, STATUS_SEVERITY.indexOf(status));
  return STATUS_SEVERITY[worst]!;
}

export function isFailing(status: Status): boolean {
  return status === "warn" || status === "crit" || status === "unknown";
}

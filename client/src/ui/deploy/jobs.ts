import type { DeployJobState } from "@contracts/deploy";
import type { DetectState } from "@contracts/catalog";

export const FINISHED_STATES: readonly DeployJobState[] = ["succeeded", "failed", "cancelled"];

export function isFinished(state: DeployJobState): boolean {
  return FINISHED_STATES.includes(state);
}

export const JOB_STATE_COLOR: Record<DeployJobState, string> = {
  pending: "gray",
  running: "cyan",
  succeeded: "teal",
  failed: "red",
  cancelled: "gray",
};

export const DETECT_LABEL: Record<DetectState, string> = {
  installed: "installed",
  "not-installed": "not installed",
  unknown: "unknown",
};

export const DETECT_COLOR: Record<DetectState, string> = {
  installed: "teal",
  "not-installed": "gray",
  unknown: "yellow",
};

// What the plan shows in place of a secret input's value.
export const MASKED = "********";

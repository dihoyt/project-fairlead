import { z } from "zod";
import type { Setting, SettingsRegistry } from "../../contracts/platform.js";

// Fleet's own bundle states, plus the GitRepo-level conditions this module
// judges: the git fetch failing and a paused repo.
export const STATES = [
  "ErrApplied",
  "NotReady",
  "Modified",
  "OutOfSync",
  "WaitApplied",
  "Pending",
  "SyncFailed",
  "Paused",
] as const;

export type FleetState = (typeof STATES)[number];

// States a healthy rollout passes through. While one is younger than the
// grace period it is reported a level milder than its severity.
export const TRANSITIONAL: ReadonlySet<FleetState> = new Set(["NotReady", "OutOfSync", "WaitApplied", "Pending"]);

const severity = z.enum(["ok", "warn", "crit"]);
export type Severity = z.infer<typeof severity>;

export const DEFAULT_SEVERITY: Record<FleetState, Severity> = {
  ErrApplied: "crit",
  NotReady: "crit",
  SyncFailed: "crit",
  Modified: "warn",
  OutOfSync: "warn",
  WaitApplied: "warn",
  Pending: "warn",
  Paused: "warn",
};

export interface FleetSettings {
  rancherUrl: Setting<string>;
  graceMinutes: Setting<number>;
  severity: Setting<Partial<Record<FleetState, Severity>>>;
}

export function declareSettings(settings: SettingsRegistry): FleetSettings {
  return {
    rancherUrl: settings.declare({
      key: "fleet.rancherUrl",
      label: "Rancher URL",
      help: "Base URL of the Rancher that runs Fleet, e.g. https://rancher.example.com. Fleet checks link into its Continuous Delivery pages; empty links to the git host instead.",
      schema: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]),
      default: "",
      env: "RANCHER_URL",
    }),
    graceMinutes: settings.declare({
      key: "fleet.graceMinutes",
      label: "Rollout grace period (minutes)",
      help: "How long a bundle may stay NotReady, OutOfSync, WaitApplied or Pending before it counts at full severity.",
      schema: z.number().int().min(0).max(1440),
      default: 10,
      env: "FLEET_GRACE_MINUTES",
    }),
    severity: settings.declare({
      key: "fleet.severity",
      label: "Severity by Fleet state",
      help: `Overrides per state (${STATES.join(", ")}): "ok", "warn" or "crit".`,
      schema: z.partialRecord(z.enum(STATES), severity),
      default: {},
      env: "FLEET_SEVERITY",
    }),
  };
}

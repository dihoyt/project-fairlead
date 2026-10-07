import { z } from "zod";
import type { Setting, SettingsRegistry } from "../../contracts/platform.js";

// Env values arrive as strings; the UI sends numbers.
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const baseUrl = z.union([z.literal(""), z.url({ protocol: /^https?$/ }).transform((url) => url.replace(/\/+$/, ""))]);

export interface Thresholds {
  podPendingMinutes: number;
  pvcPendingMinutes: number;
  restartSpikeCount: number;
  restartSpikeMinutes: number;
  certWarnDays: number;
  certCritDays: number;
  apiCertWarnDays: number;
  apiCertCritDays: number;
  volumeWarnPercent: number;
  volumeCritPercent: number;
}

export interface ClusterSettings {
  thresholds(): Thresholds;
  rancherUrl: Setting<string>;
  headlampUrl: Setting<string>;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  podPendingMinutes: 15,
  pvcPendingMinutes: 15,
  restartSpikeCount: 5,
  restartSpikeMinutes: 60,
  certWarnDays: 14,
  certCritDays: 7,
  apiCertWarnDays: 30,
  apiCertCritDays: 7,
  volumeWarnPercent: 80,
  volumeCritPercent: 90,
};

export function declareSettings(settings: SettingsRegistry): ClusterSettings {
  const num = (name: keyof Thresholds, env: string, label: string, min: number, max: number, help?: string) =>
    settings.declare({
      key: `cluster.${name}`,
      label,
      ...(help ? { help } : {}),
      schema: int(min, max),
      default: DEFAULT_THRESHOLDS[name],
      env,
    });
  const t = {
    podPendingMinutes: num(
      "podPendingMinutes",
      "CLUSTER_POD_PENDING_MINUTES",
      "Pod pending warning (minutes)",
      1,
      1440,
      "A pod still Pending after this long is reported."
    ),
    pvcPendingMinutes: num(
      "pvcPendingMinutes",
      "CLUSTER_PVC_PENDING_MINUTES",
      "PVC pending warning (minutes)",
      1,
      1440
    ),
    restartSpikeCount: num(
      "restartSpikeCount",
      "CLUSTER_RESTART_SPIKE_COUNT",
      "Restart spike: restarts",
      1,
      1000,
      "A container restarting this many times within the window below is reported."
    ),
    restartSpikeMinutes: num(
      "restartSpikeMinutes",
      "CLUSTER_RESTART_SPIKE_MINUTES",
      "Restart spike: window (minutes)",
      5,
      1440
    ),
    certWarnDays: num("certWarnDays", "CLUSTER_CERT_WARN_DAYS", "Certificate expiry warning (days)", 1, 365),
    certCritDays: num("certCritDays", "CLUSTER_CERT_CRIT_DAYS", "Certificate expiry critical (days)", 0, 365),
    apiCertWarnDays: num(
      "apiCertWarnDays",
      "CLUSTER_API_CERT_WARN_DAYS",
      "API server certificate warning (days)",
      1,
      365
    ),
    apiCertCritDays: num(
      "apiCertCritDays",
      "CLUSTER_API_CERT_CRIT_DAYS",
      "API server certificate critical (days)",
      0,
      365
    ),
    volumeWarnPercent: num(
      "volumeWarnPercent",
      "CLUSTER_VOLUME_WARN_PERCENT",
      "Volume usage warning (%)",
      1,
      100,
      "From the kubelet's volume stats; needs get on nodes/proxy."
    ),
    volumeCritPercent: num("volumeCritPercent", "CLUSTER_VOLUME_CRIT_PERCENT", "Volume usage critical (%)", 1, 100),
  } satisfies Record<keyof Thresholds, Setting<number>>;

  return {
    thresholds: () =>
      Object.fromEntries(Object.entries(t).map(([key, setting]) => [key, setting.get()])) as unknown as Thresholds,
    rancherUrl: settings.declare({
      key: "cluster.rancherUrl",
      label: "Rancher cluster explorer URL",
      help: "Deep links from cluster checks open here, e.g. https://rancher.example.com/dashboard/c/local/explorer.",
      schema: baseUrl,
      default: "",
      env: "CLUSTER_RANCHER_URL",
    }),
    headlampUrl: settings.declare({
      key: "cluster.headlampUrl",
      label: "Headlamp cluster URL",
      help: "Used for deep links when no Rancher URL is set, e.g. https://headlamp.example.com/c/main.",
      schema: baseUrl,
      default: "",
      env: "CLUSTER_HEADLAMP_URL",
    }),
  };
}

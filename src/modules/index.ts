import type { Module } from "../contracts/module.js";
import k8s from "./k8s/index.js";
import health from "./health/index.js";
import metrics from "./metrics/index.js";
import notify from "./notify/index.js";
import cluster from "./cluster/index.js";
import longhorn from "./longhorn/index.js";
import velero from "./velero/index.js";
import fleet from "./fleet/index.js";
import hosts from "./hosts/index.js";
import checks from "./checks/index.js";
import backups from "./backups/index.js";
import metricsK8s from "./metrics-k8s/index.js";
import workloads from "./workloads/index.js";
import onboarding from "./onboarding/index.js";
import catalog from "./catalog/index.js";
import deploy from "./deploy/index.js";
import connectors from "./connectors/index.js";
import connectorCloudflare from "./connector-cloudflare/index.js";
import connectorEntra from "./connector-entra/index.js";
import templates from "./templates/index.js";
import publish from "./publish/index.js";

// Load order. "k8s" comes first because it provides the k8s service the
// providers look up; everything else only needs the registries, which exist
// before any module loads. Nobody edits this file after the skeleton: a new
// module is a contract change.
export const modules: readonly Module[] = [
  k8s,
  health,
  metrics,
  notify,
  cluster,
  longhorn,
  velero,
  fleet,
  hosts,
  checks,
  backups,
  metricsK8s,
  workloads,
  onboarding,
  catalog,
  deploy,
  connectors,
  connectorCloudflare,
  connectorEntra,
  templates,
  publish,
];

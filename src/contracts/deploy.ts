// Deploying catalog apps (module "deploy"). A deploy runs as a Kubernetes
// Job in this product's namespace, under a separate installer ServiceAccount
// the chart creates only when deploys are turned on (deploy.enabled). The
// product's own ServiceAccount stays read-only apart from creating and
// reading those Jobs and their values Secrets in its own namespace.
//
// Server-free on purpose: the client imports this file.

import type { DiskCheck } from "./disk.js";

export type DeployValue = string | boolean;

export interface DeployRequest {
  appId: string;
  // Default: the catalog entry's namespace.
  namespace?: string;
  // By CatalogInput.key. Secret inputs are write-only: they go into the
  // Job's values Secret and are never returned or logged.
  inputs: Record<string, DeployValue>;
}

export interface DeployStatus {
  // The chart granted the installer (deploy.enabled=true).
  enabled: boolean;
  // When off: what to run to turn it on, a fixed command with the release
  // and namespace filled in.
  enableHint?: string;
  namespace: string;
  installerServiceAccount: string;
  // The helm/kubectl image the Job runs, pinned by digest in the chart.
  image: string;
  // Effective defaults after settings and discovery.
  defaults: {
    baseDomain?: string;
    ingressClass?: string;
    clusterIssuer?: string;
    storageClass?: string;
  };
}

export interface PlannedObject {
  kind: string;
  name: string;
  namespace?: string;
}

// The preview shown before anything runs. Built without touching the
// cluster beyond reads; a "dry-run" job renders the full manifest.
export interface DeployPlan {
  appId: string;
  release: string;
  namespace: string;
  version: string;
  // false when deploys are off, a required app is missing, or an input is
  // invalid; blockedBy says which in one sentence.
  allowed: boolean;
  blockedBy?: string;
  // Catalog ids from `requires` that discovery did not find.
  missingRequires: string[];
  // Every input after defaults, secrets as "********".
  inputs: Record<string, DeployValue>;
  // Field errors by input key.
  inputErrors: Record<string, string>;
  // The command lines the Job will run, secrets masked.
  commands: string[];
  // Rendered Helm values (or the patch) as YAML, secrets masked.
  values: string;
  // The objects this product creates to run it: the Job, its values Secret,
  // the target namespace when new.
  creates: PlannedObject[];
  // Where the UI will be once it is up.
  url?: string;
  warnings: string[];
}

export type DeployMode = "install" | "dry-run";

// What a job did. "upgrade" jobs come only from POST /api/deploy/upgrades:
// `helm upgrade` with --reuse-values (no --install), or the pinned manifest
// applied again.
export type DeployJobMode = DeployMode | "upgrade";

export type DeployJobState = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface DeployJobView {
  id: string;
  appId: string;
  release: string;
  namespace: string;
  version: string;
  mode: DeployJobMode;
  state: DeployJobState;
  startedBy: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  // The last line of the result, or why it failed.
  message?: string;
  url?: string;
  // The Kubernetes Job running it.
  job: { namespace: string; name: string };
}

export interface DeployJobRequest extends DeployRequest {
  mode: DeployMode;
}

// --- Deploy bundles ----------------------------------------------------------

export interface BundleRequest {
  bundleId: string;
  // The bundle's shared inputs: baseDomain, adminEmail, adminPassword, storageClass.
  inputs: Record<string, DeployValue>;
  // Per-app overrides, app id -> input key -> value.
  apps?: Record<string, Record<string, DeployValue>>;
  // Optional items to roll out; omitted: the ones the bundle view marks selected.
  include?: string[];
}

export interface BundlePlanStep {
  appId: string;
  // Already installed or left out: no job runs for it.
  skip: boolean;
  reason?: string;
  // Absent when skipped.
  plan?: DeployPlan;
}

export interface BundlePlan {
  bundleId: string;
  // False when any step's plan is not allowed, or the disk check is crit.
  allowed: boolean;
  // When no step is blocked but the bundle is: the disk check's detail.
  blockedBy?: string;
  steps: BundlePlanStep[];
  // The steps that run, against the nodes' free disk: checkDisk() from
  // ./disk.ts over their catalog footprints and discovery's nodeDisks.
  disk?: DiskCheck;
}

export type BundleStepState = "pending" | "skipped" | "running" | "succeeded" | "failed" | "cancelled";

export type BundleRunState = "running" | "succeeded" | "failed" | "cancelled";

export interface BundleRunView {
  id: string;
  // UPGRADE_RUN for an upgrade run.
  bundleId: string;
  state: BundleRunState;
  startedBy: string;
  createdAt: string;
  finishedAt?: string;
  steps: Array<{ appId: string; state: BundleStepState; jobId?: string; message?: string; url?: string }>;
}

// --- Upgrades ----------------------------------------------------------------
// Install once, then upgrade on purpose: nothing upgrades by itself. Upgrades
// cover the apps this product's deploy runner installed (DetectedApp.ownedByUs),
// moving each to the catalog's pin, or to the newest fallback the cluster's
// Kubernetes can run (pickVersion() in ./kubeversion.ts), never to a version
// the cluster can't run and never backwards.

// The bundleId of an upgrade run. Upgrade runs are bundle runs: they share
// GET /api/deploy/bundles(/:id), cancel, the one-run-at-a-time rule and the
// deploy.bundle-finished event.
export const UPGRADE_RUN = "upgrade";

// available: targetVersion is newer than currentVersion.
// current: nothing newer the cluster can run (reason says when the catalog
//   pin is newer but needs a newer Kubernetes, or the app is ahead of it).
// blocked: can't be upgraded from here; reason says why (a job for its
//   release is running, its catalog entry is a patch, deploys are off).
// unknown: installed by us but its version can't be told; it can be named
//   in UpgradeRequest.appIds, it is never part of "all".
export type UpgradeState = "available" | "current" | "blocked" | "unknown";

export interface UpgradeNote {
  // Applies when an upgrade crosses this version: from below it to it or above.
  version: string;
  // One or two plain sentences: what changes, what to do before or after.
  note: string;
}

export interface UpgradeCandidate {
  appId: string;
  release: string;
  namespace: string;
  // The version of its latest successful install or upgrade job, else
  // DetectedApp.chartVersion (a manifest app has none).
  currentVersion?: string;
  // The catalog's pin, before the Kubernetes check.
  pinnedVersion: string;
  // What an upgrade installs: absent when no pin or fallback fits the cluster.
  targetVersion?: string;
  // targetVersion is a fallback, not the pin.
  fellBack: boolean;
  state: UpgradeState;
  // One sentence, for every state but "available".
  reason?: string;
  // The catalog's upgrade notes between currentVersion (exclusive) and
  // targetVersion (inclusive), oldest first; every note up to targetVersion
  // when currentVersion is unknown.
  notes: UpgradeNote[];
  // The command lines the job would run, display only, as DeployPlan.commands.
  commands: string[];
  url?: string;
}

export interface UpgradeReport {
  checkedAt: string;
  // DiscoveryReport.kubernetesVersion.
  kubernetesVersion?: string;
  // False when deploys are off; every candidate is then "blocked".
  enabled: boolean;
  // In catalog install order (an app's requires before it).
  apps: UpgradeCandidate[];
}

export interface UpgradeRequest {
  // Omitted: every candidate whose state is "available". Named apps must be
  // "available" or "unknown"; anything else is a 400 naming the app and its
  // reason. Run in catalog install order whatever order they are given in.
  appIds?: string[];
}

// --- For other modules -------------------------------------------------------

// A release the deploy runner installed (its latest install or upgrade job), so
// discovery can tell "installed by us" where a chart ignores the label.
export interface DeployedRelease {
  appId: string;
  release: string;
  namespace: string;
  jobId: string;
  state: DeployJobState;
}

// Provided by module "deploy" as ctx.services.get("deploy").
export interface DeployService {
  // The latest install or upgrade job per release, newest first; dry runs excluded.
  releases(): Promise<DeployedRelease[]>;
}

// Deploying catalog apps (module "deploy"). A deploy runs as a Kubernetes
// Job in this product's namespace, under a separate installer ServiceAccount
// the chart creates only when deploys are turned on (deploy.enabled). The
// product's own ServiceAccount stays read-only apart from creating and
// reading those Jobs and their values Secrets in its own namespace.
//
// Server-free on purpose: the client imports this file.

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

export type DeployJobState = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface DeployJobView {
  id: string;
  appId: string;
  release: string;
  namespace: string;
  version: string;
  mode: DeployMode;
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
  // False when any step's plan is not allowed.
  allowed: boolean;
  steps: BundlePlanStep[];
}

export type BundleStepState = "pending" | "skipped" | "running" | "succeeded" | "failed" | "cancelled";

export type BundleRunState = "running" | "succeeded" | "failed" | "cancelled";

export interface BundleRunView {
  id: string;
  bundleId: string;
  state: BundleRunState;
  startedBy: string;
  createdAt: string;
  finishedAt?: string;
  steps: Array<{ appId: string; state: BundleStepState; jobId?: string; message?: string; url?: string }>;
}

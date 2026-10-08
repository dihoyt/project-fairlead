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
// applied again. "action" jobs come only from POST /api/deploy/actions/run.
export type DeployJobMode = DeployMode | "upgrade" | "action";

export type DeployJobState = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface DeployJobView {
  id: string;
  appId: string;
  release: string;
  namespace: string;
  version: string;
  mode: DeployJobMode;
  // Set for mode "action".
  action?: DeployActionKind;
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
  // The bundle's shared inputs: access, baseDomain, adminEmail, adminPassword,
  // storageClass, and the access mode's own.
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

// --- Deploy actions ----------------------------------------------------------
// A change to something already in the cluster, made by the deploy runner the
// same way as an install: a Job under the installer ServiceAccount running
// fixed kubectl/helm commands, so this product's own ServiceAccount stays
// read-only. Each run is a deploy job (mode "action"): progress, logs and
// cancel go through /api/deploy/jobs, one job per release at a time, and it
// ends with deploy.finished. Needs deploy.enabled, like installs.

export type DeployActionKind = "longhorn-replicas" | "migrate-to-longhorn";

// Raises Longhorn's default-replica-count Setting (what new volumes get),
// the replica count pinned by a Longhorn StorageClass when it is lower, and,
// with existingVolumes, spec.numberOfReplicas on every volume below it.
// Never lowers anything.
export interface LonghornReplicasAction {
  kind: "longhorn-replicas";
  // 1 to 3. Default: LonghornReplicaAdvice.target.
  replicas?: number;
  existingVolumes: boolean;
}

// Moves one PVC's data from its current storage class to Longhorn, keeping
// the PVC's name.
export interface MigrateToLonghornAction {
  kind: "migrate-to-longhorn";
  namespace: string;
  pvc: string;
  // Default: LonghornReplicaAdvice.target.
  replicas?: number;
  // Offer a download of the data before the old volume goes.
  backupFirst?: boolean;
}

export type DeployActionRequest = LonghornReplicasAction | MigrateToLonghornAction;

export interface DeployActionStep {
  // "Raise the default replica count to 2".
  label: string;
  // The command lines the Job runs for it, display only, as DeployPlan.commands.
  commands: string[];
}

// The preview shown before anything runs; built from reads only.
export interface DeployActionPlan {
  kind: DeployActionKind;
  // The button and the job list's line: "Raise Longhorn replicas to 2".
  title: string;
  // false when deploys are off, there is nothing to do, or the request
  // doesn't fit the cluster; blockedBy says which in one sentence.
  allowed: boolean;
  blockedBy?: string;
  steps: DeployActionStep[];
  // What stops while it runs, in one sentence; absent when nothing does.
  downtime?: string;
  // What happens if a step fails, in one sentence.
  rollback?: string;
  // Objects it changes in place.
  changes: PlannedObject[];
  // Objects it creates, the Job and its Secret included.
  creates: PlannedObject[];
  warnings: string[];
}

// --- Access: how people reach the deployed apps ----------------------------

// Decides how every app's Ingress is written, so it is chosen before any app
// is deployed and saved for later deploys:
// - cloudflare-tunnel: cloudflared runs in the cluster; one wildcard public
//   hostname on the tunnel routes to the ingress controller. Cloudflare
//   terminates TLS, so Ingresses carry none; URLs are https.
// - tailscale: the Tailscale operator; app Ingresses use its "tailscale"
//   class and get https://<label>.<tailnet>, reachable on the tailnet only.
// - local: hostnames only the local network resolves (a hosts file or local
//   DNS); no certificates, URLs are http.
// - direct: a public wildcard DNS record at ports forwarded to the ingress;
//   certificates from cert-manager's issuer.
export type AccessMode = "cloudflare-tunnel" | "tailscale" | "local" | "direct";

export interface AccessRequest {
  mode: AccessMode;
  // Apps get <label>.<baseDomain>. Tailscale: the tailnet's DNS name,
  // "tail1234.ts.net".
  baseDomain: string;
}

export interface AccessHost {
  appId?: string;
  host: string;
  url: string;
  // The name resolves from this product's pod. Absent when not looked up
  // (tailscale: the pod is not on the tailnet).
  resolves?: boolean;
}

export interface AccessView {
  // Unset until the Access step is saved.
  mode?: AccessMode;
  baseDomain?: string;
  // The catalog app the mode needs (cloudflared, tailscale-operator) and
  // whether discovery found it.
  appId?: string;
  appInstalled?: boolean;
  // Ingress hosts under baseDomain (tailscale: the tailscale-class ones).
  hosts: AccessHost[];
  // cloudflare-tunnel: the tunnel's public hostname; direct: the DNS record.
  // "*.example.com".
  wildcard?: string;
  // cloudflare-tunnel: the service that public hostname routes to.
  ingressService?: string;
  // local and direct: what the names must point at, when discovery found it.
  ingressAddress?: string;
  // local: "<address> <host>" per host, ready to paste into a hosts file;
  // "<ingress IP>" stands in for an address discovery could not find.
  hostsFile?: string;
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

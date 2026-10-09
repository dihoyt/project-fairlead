// Deploying catalog apps (module "deploy"). A deploy runs as a Kubernetes
// Job in this product's namespace, under a separate installer ServiceAccount
// the chart creates only when deploys are turned on (deploy.enabled). The
// product's own ServiceAccount stays read-only apart from creating and
// reading those Jobs and their values Secrets in its own namespace.
//
// Server-free on purpose: the client imports this file.

import type { BackupSchedule, RestoreMode } from "./backups.js";
import type { CatalogEntry } from "./catalog.js";
import type { DiskCheck } from "./disk.js";
import type { PostgresBackupRequest, PostgresRestoreRequest } from "./postgres.js";

export type DeployValue = string | boolean;

export interface DeployRequest {
  appId: string;
  // Default: the catalog entry's namespace.
  namespace?: string;
  // By CatalogInput.key. Secret inputs are write-only: they go into the
  // Job's values Secret and are never returned or logged.
  inputs: Record<string, DeployValue>;
  // Leave the app reachable without signing in to the console (see
  // "Sign-in gate" below). Default false; ignored for an entry whose
  // CatalogEntry.gate is "public", which always is.
  public?: boolean;
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
  // How the sign-in gate will treat it; absent for an app with no UI.
  gate?: { state: AppGateState; reason?: string };
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
  // Apps to leave reachable without signing in to the console
  // (DeployRequest.public for each).
  public?: string[];
}

export interface BundlePlanStep {
  appId: string;
  // Already installed or left out: no job runs for it.
  skip: boolean;
  reason?: string;
  // Absent when skipped.
  plan?: DeployPlan;
  // The catalog's CatalogEntry.memoryBytes; absent when skipped or unknown.
  memoryBytes?: number;
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
  // The steps that run, summed where known.
  memoryBytes?: number;
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

export type DeployActionKind =
  | "longhorn-replicas"
  | "migrate-to-longhorn"
  | "migrate-storage"
  | "backup-volumes"
  | "remove-app"
  | "app-gate"
  | "traefik-ports"
  | "longhorn-target"
  | "longhorn-recurring"
  | "longhorn-backup-now"
  | "longhorn-restore"
  | "console-backup"
  | "node-cordon"
  | "node-uncordon"
  | "node-drain"
  | "node-reboot"
  | "pg-database"
  | "pg-backups"
  | "pg-backup-now"
  | "pg-restore"
  | "pg-remove-cluster";

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

// Moves every local-path volume an app we deployed mounts to Longhorn in one
// stop: scale its workloads to zero, copy each volume into a new Longhorn
// volume with a Job, rebind the claim under the same name to the copy, scale
// back up, check the app answers, then delete the old volumes. Until that
// last step any failure puts the claims back on their old volumes (kept by
// setting them to Retain first) and starts the app again.
export interface MigrateToLonghornAction {
  kind: "migrate-to-longhorn";
  appId: string;
}

// A tar.gz of each volume migrate-to-longhorn would move, for the user to
// download first: a pod in the app's namespace mounts them read-only while
// the app keeps running, and this product streams each one from it. The job
// succeeds once the pod serves; downloads go through
// /api/deploy/actions/backups/:id with the job's id. The pod stops after an
// hour, at .../done, or when a conversion of the app starts.
export interface BackupVolumesAction {
  kind: "backup-volumes";
  appId: string;
}

// Removes an app deployed from the Templates page (a namespace labelled
// <labelDomain>/app-template; any other app is refused). Without
// deleteVolumes (the default) everything in its namespace goes except the
// namespace itself and its PersistentVolumeClaims, so deploying the same
// name again picks the data back up; with it the namespace is deleted and
// the volumes with it. The HTTP check watching its address is deleted when
// the job starts. The deploy.finished that follows carries action
// "remove-app", on which the templates module forgets the instance.
export interface RemoveAppAction {
  kind: "remove-app";
  appId: string;
  deleteVolumes?: boolean;
}

// Puts an app the deploy runner installed behind the sign-in gate, or makes
// it public: saves the choice (what later installs and upgrades apply) and
// sets or removes the gate middleware on each of its Ingresses in place,
// keeping any other middleware they carry. Refused for an entry whose
// CatalogEntry.gate is "public" and, to gate, when the gate can't work
// (GateStatus.ready false).
export interface AppGateAction {
  kind: "app-gate";
  appId: string;
  public: boolean;
}

// Makes Traefik serve exactly the entrypoints external services ask for
// (PortsView.wanted): adds the missing ones and removes the ones this
// product added that nothing wants any more, leaving every other port and
// value alone. Where Traefik's values live decides how (PortsView.traefik):
// k3s's bundled Traefik through the HelmChartConfig kube-system/traefik
// (created when absent, its valuesContent merged otherwise), a Traefik this
// product installed through `helm upgrade --reuse-values`. Either way
// Traefik restarts once. Refused when a wanted port is outside the range.
export interface TraefikPortsAction {
  kind: "traefik-ports";
}

// migrate-to-longhorn in either direction, by the same claim swap:
// to "longhorn" is migrate-to-longhorn (that kind stays as its alias);
// to "local-path" moves every Longhorn volume the app mounts onto one
// node's local-path volume, which the plan warns leaves Longhorn backups
// and replicas behind. Refused when the app has no volume to move.
export interface MigrateStorageAction {
  kind: "migrate-storage";
  appId: string;
  to: "longhorn" | "local-path";
}

// --- Backup set-up actions (module "backups" starts them) ---
// All run in longhorn-system and take the release "longhorn", so one runs at
// a time; refused while Longhorn is not installed.

// Points Longhorn's default BackupTarget at a storage-target connector
// (spec.backupTargetURL from StorageTargetView.url) and, for s3 and smb,
// applies the credential Secret from StorageTargetService.credentialsSecret()
// in longhorn-system and sets spec.credentialSecret to it. connectorId null
// clears the URL and the credential reference; the Secret this product made
// is deleted.
export interface LonghornTargetAction {
  kind: "longhorn-target";
  connectorId: string | null;
}

// Makes Longhorn's RecurringJobs match the schedules (one snapshot and one
// backup job per group, named "<externalPrefix><group>-snapshot" and
// "-backup", labelled managed-by; others are left alone), and/or sets
// volumes' group labels (recurring-job-group.longhorn.io/<group>: enabled)
// on their Longhorn Volume. At least one of the two is given; schedules is
// the whole set, as BackupSchedulesRequest.
export interface LonghornRecurringAction {
  kind: "longhorn-recurring";
  schedules?: BackupSchedule[];
  volumes?: Array<{ namespace: string; claim: string; groups: string[] }>;
}

// Takes a snapshot of the claim's Longhorn volume and backs it up to the
// target now. Refused without an available target.
export interface LonghornBackupNowAction {
  kind: "longhorn-backup-now";
  namespace: string;
  claim: string;
}

// Restores a Longhorn Backup (VolumeRestorePoint.id) of the claim's volume.
// new-pvc: a new Longhorn volume from the backup and a claim `newClaim`
// bound to it in the same namespace. in-place: scale the workloads that
// mount the claim to zero, restore to a new volume, rebind the claim under
// the same name to it (actions/migrate.ts's swap, old volume kept with
// Retain until the app answers), scale back up, check.
export interface LonghornRestoreAction {
  kind: "longhorn-restore";
  namespace: string;
  claim: string;
  backup: string;
  mode: RestoreMode;
  // new-pvc only; required there.
  newClaim?: string;
}

// The console's own data, now: SQLite's online backup of its database to a
// file on its volume, copied to the storage target. Runs in the console's
// namespace under the installer ServiceAccount. Nightly runs are scheduled
// by module "backups" through the same action.
export interface ConsoleBackupAction {
  kind: "console-backup";
  connectorId: string;
}
// --- Node actions ---
// Each runs as an action job like the rest, under the installer
// ServiceAccount. The job row's appId and release are "node-<node>", so one
// action per node runs at a time and list_deploy_jobs can filter by node.

// Marks the node unschedulable (kubectl cordon); running pods stay.
export interface NodeCordonAction {
  kind: "node-cordon";
  node: string;
}

// Makes the node schedulable again (kubectl uncordon).
export interface NodeUncordonAction {
  kind: "node-uncordon";
  node: string;
}

export interface NodeDrainOptions {
  // Leave DaemonSet pods in place (--ignore-daemonsets). Default true;
  // false refuses the drain while the node runs one.
  ignoreDaemonSets?: boolean;
  // Evict pods that use emptyDir volumes, losing that data
  // (--delete-emptydir-data). Default false: such a pod blocks the drain.
  deleteEmptyDirData?: boolean;
  // How long evictions may wait, PodDisruptionBudgets included, before the
  // drain fails (--timeout). 30 to 3600, default 300. There is no force
  // option: unmanaged pods and PDB-blocked evictions fail the drain.
  timeoutSeconds?: number;
}

// Cordons, then evicts the node's pods through the eviction API, so
// PodDisruptionBudgets are respected (kubectl drain). Refused for the last
// schedulable control-plane node of a single-node cluster.
export interface NodeDrainAction extends NodeDrainOptions {
  kind: "node-drain";
  node: string;
}

// Drains the node, reboots it, waits for it to go NotReady and come back
// Ready, then uncordons it. How the reboot command reaches the node is the
// recipe's choice; the plan's blockedBy says when a node can't be rebooted
// from here.
export interface NodeRebootAction extends NodeDrainOptions {
  kind: "node-reboot";
  node: string;
}

// --- Shared Postgres actions (./postgres.ts) ---
// All run in the postgres namespace and take the release "postgres", so one
// runs at a time; refused while the shared cluster is not installed.

// A database and a login role on the shared cluster for an app, both named
// pgName(appId): CloudNativePG Database and DatabaseRole objects (reclaim
// policy retain, so removing them leaves the data), the role's password in
// a Secret beside them, and the app's connection Secret pgSecretName(appId)
// in `namespace`. Running it again keeps the database and sets a new
// password in both Secrets. Installing an app whose CatalogEntry.database
// is "postgres" runs the same steps before its chart.
export interface PgDatabaseAction {
  kind: "pg-database";
  appId: string;
  namespace: string;
}

// Sets up the shared cluster's backups (PostgresBackupRequest). pitr: an
// ObjectStore for the target with its credential Secret
// (StorageTargetService.credentialsSecret, by key reference), the Barman
// Cloud plugin as the Cluster's WAL archiver, and a ScheduledBackup. dump: a
// CronJob running pg_dumpall onto a Longhorn claim in the "critical" group;
// refused unless the target is Longhorn's backup target. Switching method
// removes the other one's objects; null removes both.
export interface PgBackupsAction extends PostgresBackupRequest {
  kind: "pg-backups";
}

// A base backup (pitr) or a dump (dump) now. Refused while backups are off.
export interface PgBackupNowAction {
  kind: "pg-backup-now";
}

// Never in place. A new Cluster from the backup (pitr: recovered to `at`;
// dump: initialised, then loaded from the dump), its databases' objects
// made for it, every app's connection Secret pointed at it and the app's
// workloads restarted; backups move to it. The old Cluster is hibernated
// and kept (PostgresClusterView.previous) until pg-remove-cluster.
export interface PgRestoreAction extends PostgresRestoreRequest {
  kind: "pg-restore";
}

// Deletes a cluster a restore replaced, with its volumes. Refused for the
// cluster the apps use now.
export interface PgRemoveClusterAction {
  kind: "pg-remove-cluster";
  name: string;
}

export type PostgresActionRequest =
  PgDatabaseAction | PgBackupsAction | PgBackupNowAction | PgRestoreAction | PgRemoveClusterAction;

export type NodeActionRequest = NodeCordonAction | NodeUncordonAction | NodeDrainAction | NodeRebootAction;

export type DeployActionRequest =
  | LonghornReplicasAction
  | MigrateToLonghornAction
  | MigrateStorageAction
  | BackupVolumesAction
  | RemoveAppAction
  | AppGateAction
  | TraefikPortsAction
  | LonghornTargetAction
  | LonghornRecurringAction
  | LonghornBackupNowAction
  | LonghornRestoreAction
  | ConsoleBackupAction
  | NodeActionRequest
  | PostgresActionRequest;

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
  // Objects it deletes (remove-app); a namespace stands for everything in it.
  deletes?: PlannedObject[];
  // migrate-to-longhorn and backup-volumes: the volumes it moves or saves;
  // remove-app: the volumes it keeps, or deletes with deleteVolumes.
  volumes?: ActionVolume[];
  // migrate-to-longhorn: Longhorn can place replicas on more than one node,
  // so raising replicas (longhorn-replicas) is offered once it is done.
  offerReplicas?: boolean;
  // node-drain and node-reboot: the node's pods and what the drain does
  // with each, as read when the plan was made.
  pods?: DrainPod[];
}

// evict: evicted and rescheduled elsewhere by its controller.
// skip: left in place (a DaemonSet pod with ignoreDaemonSets, a mirror pod).
// block: stops the drain; reason says why (no controller, emptyDir without
//   deleteEmptyDirData, a DaemonSet without ignoreDaemonSets).
// wait: evictable, but a PodDisruptionBudget allows no disruption right now;
//   the drain waits for it up to timeoutSeconds.
export type DrainPodOutcome = "evict" | "skip" | "block" | "wait";

export interface DrainPod {
  namespace: string;
  name: string;
  // The controlling owner, "ReplicaSet/web-6d4f" or "DaemonSet/longhorn-manager".
  owner?: string;
  outcome: DrainPodOutcome;
  // One sentence for skip, block and wait.
  reason?: string;
  // wait: the PodDisruptionBudget holding it.
  pdb?: string;
}

export interface ActionVolume {
  namespace: string;
  // The PersistentVolumeClaim; its name stays the same.
  claim: string;
  storageClass: string;
  // Requested size as written, "5Gi".
  size: string;
  // In use, from the kubelet, when a running pod mounts it.
  usedBytes?: number;
  // The node a local-path volume lives on.
  node?: string;
  // migrate-to-longhorn: the Longhorn storage class it moves to.
  targetStorageClass?: string;
}

// preparing: the backup job is still starting the pod. ready: downloads
// work. failed: the job failed; message says why. gone: the pod has
// stopped (an hour passed, done was called, or a conversion started).
export type VolumeBackupState = "preparing" | "ready" | "failed" | "gone";

export interface VolumeBackupView {
  // The backup-volumes job's id.
  id: string;
  appId: string;
  namespace: string;
  state: VolumeBackupState;
  message?: string;
  // When the pod stops by itself.
  expiresAt?: string;
  files: Array<{
    claim: string;
    // Relative to the API base: "api/deploy/actions/backups/dj_9/files/gitea-shared-storage".
    path: string;
    // "gitea-gitea-shared-storage-2026-10-08.tar.gz".
    filename: string;
  }>;
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

// --- Sign-in gate -------------------------------------------------------------
// Every app the deploy runner publishes sits behind the console's own
// sign-in until it is made public. Its Ingresses carry a Traefik
// forwardAuth middleware that asks the console about each request
// (GATE_FORWARD_PATH in ./platform.ts); only people signed in to the
// console get through, so once sign-in goes through Authentik or Entra the
// gate does too. Works for every access mode whose Ingresses Traefik serves
// (cloudflare-tunnel, direct, local). With tailscale the operator's own
// proxy serves the app and the tailnet is the gate. Cloudflare Access, when
// on, is a separate layer in front.

// gated: every Ingress of the app carries the gate.
// public: left reachable without the console's sign-in on purpose (the
//   saved choice, or CatalogEntry.gate "public").
// open: published with no gate although not made public; reason says why
//   (the ingress class is not Traefik, the gate isn't ready, an Ingress lost
//   the middleware). Anyone with the URL reaches it.
// tailnet: served by the Tailscale operator; only the tailnet reaches it.
export type AppGateState = "gated" | "public" | "open" | "tailnet";

export interface AppGateView {
  appId: string;
  name: string;
  state: AppGateState;
  // The saved choice: what the next install, upgrade or app-gate applies.
  public: boolean;
  // CatalogEntry.gate: "public" can't be gated; "credentials" lets requests
  // carrying their own Authorization header through to the app.
  mode?: "credentials" | "public";
  // Its Ingress hosts (discovery), sorted.
  hosts: string[];
  // One sentence, for "open" always, otherwise when there is more to say.
  reason?: string;
}

export interface GateStatus {
  // The gate can be applied: the access mode isn't tailscale, the ingress
  // class is Traefik's and the console has a public URL to send people to.
  ready: boolean;
  // Why not, one sentence.
  reason?: string;
  // The console's public URL, where people are sent to sign in.
  signInUrl?: string;
  // The Middleware every gated Ingress references,
  // "<namespace>-<name>@kubernetescrd".
  middleware?: string;
  // Every app the deploy runner installed that has an Ingress, by name.
  apps: AppGateView[];
}

// --- Forwarded ports ----------------------------------------------------------
// Ports the router forwards to the cluster, for external services over TCP
// and UDP (EXTERNAL_TEMPLATE in ./templates.ts). The range is the
// "deploy.forwardedPorts" setting: "25565-25575,27015", ports 1024-65535,
// at most MAX_FORWARDED_PORTS in all, none of Traefik's own (RESERVED_PORTS).
// Each public port in use becomes one Traefik entrypoint per protocol,
// exposed on Traefik's Service at the same port, so its LoadBalancer
// (k3s ServiceLB on the nodes, or MetalLB) answers there.

export const MAX_FORWARDED_PORTS = 100;

// Traefik's own entrypoints' container ports in its chart (web, websecure,
// traefik, metrics), which an entrypoint can't reuse.
export const RESERVED_PORTS: readonly number[] = [8000, 8080, 8443, 9000, 9100];

export type ForwardedProtocol = "tcp" | "udp";

export interface ForwardedPort {
  port: number;
  protocol: ForwardedProtocol;
}

// An external service's claim on a public port.
export interface WantedPort extends ForwardedPort {
  // The template instance's name.
  appId: string;
}

// The entrypoint's name in Traefik's values and its Service port name,
// "tcp-25565". At most 15 characters, as a Service port name must be.
export function traefikEntrypoint(port: ForwardedPort): string {
  return `${port.protocol}-${port.port}`;
}

export interface PortsView {
  // The setting as written; "" when unset.
  range: string;
  // Parsed and merged, ascending; empty when unset.
  ranges: Array<{ from: number; to: number }>;
  // Why the setting can't be used, one sentence; ranges is then empty.
  rangeError?: string;
  // Where Traefik's values live, absent when no Traefik was found.
  // k3s: k3s's bundled Traefik, whose values are the HelmChartConfig
  // kube-system/traefik (the action creates it or merges into it).
  // release: the catalog's Traefik that this product's deploy runner installed.
  traefik?:
    | { kind: "k3s"; namespace: string; service: string }
    | { kind: "release"; namespace: string; service: string; release: string };
  // One sentence when traefik is absent or can't be changed from here
  // (another tool manages it).
  traefikNote?: string;
  // Entrypoints Traefik's Service exposes now that follow traefikEntrypoint().
  open: ForwardedPort[];
  // What external services ask for, by public port then protocol.
  wanted: WantedPort[];
  // Wanted ports outside the range; the action is refused while any is.
  outOfRange: WantedPort[];
  // open matches wanted (both as sets of entrypoint names).
  inSync: boolean;
  // Traefik Service's external address (LoadBalancer ingress), where the
  // ports answer inside the network; absent when it has none.
  address?: string;
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
  // The latest install or upgrade job per release, newest first; dry runs
  // excluded, and so is a release a later remove-app action removed.
  releases(): Promise<DeployedRelease[]>;
  // What GET /api/deploy/access answers, for work that runs without a request.
  access(): Promise<AccessView>;
  // What GET /api/deploy/gate answers: each published app's sign-in gate
  // state by host, for work that runs without a request.
  gate(): Promise<GateStatus>;
  // A CatalogEntry another module built (a template instance: install kind
  // "manifest", bundled), planned and run exactly as a catalog app with
  // that id would be: same defaults, access-mode Ingress from its "host"
  // input, jobs, audit and deploy.finished. request.appId must be entry.id.
  // planEntry is POST /api/deploy/plan's result; startEntry answers as
  // POST /api/deploy/jobs does (HttpError 400 when not allowed, 409 while
  // the release has a job running).
  planEntry(entry: CatalogEntry, request: DeployRequest): Promise<DeployPlan>;
  startEntry(actor: string, entry: CatalogEntry, request: DeployJobRequest): Promise<DeployJobView>;
}

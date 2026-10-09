// The MCP server (module "mcp"): a streamable-HTTP endpoint at /mcp on the
// same server, for Claude and other MCP clients. Every tool is a thin layer
// over REST routes in ./api.ts, called as the caller (ModuleContext.call), so
// a tool can do exactly what its routes allow and returns the shapes they
// return. Callers authenticate with an API token (./auth.ts); a "read" token
// sees only the read tools.
//
// Server-free on purpose: the client and the docs list the tools from here.

import type { ApiTokenScope } from "./auth.js";
import type {
  BackupPosture,
  BackupSchedule,
  BackupSchedulesView,
  VolumeRestorePoint,
  VolumeRestoreRequest,
} from "./backups.js";
import type { CatalogAppView, CatalogInput, CatalogSlot, DetectState, DiscoveryReport } from "./catalog.js";
import type { CheckRequest, CheckView } from "./checks.js";
import type { EntraGroup, EntraSignInRequest, EntraSignInView, StorageTargetView } from "./connectors.js";
import type {
  BundlePlan,
  BundleRequest,
  BundleRunView,
  DeployJobRequest,
  DeployActionPlan,
  DeployJobView,
  DeployPlan,
  DeployRequest,
} from "./deploy.js";
import type {
  Category,
  CategoryDetail,
  CheckResult,
  HealthBoard,
  HealthLinkRequest,
  HealthLinkView,
} from "./health.js";
import type { HostView } from "./hosts.js";
import type { NodeSummary } from "./metrics.js";
import type { TemplateDeployRequest, TemplateJobRequest, TemplatePlan, TemplatesView } from "./templates.js";
import type { LogLines, NamespaceView, PodView, WorkloadView } from "./workloads.js";

// Where MCP clients connect, relative to the install's public URL. An alias
// of POST /api/mcp, so it sits behind the same authentication.
export const MCP_PATH = "/mcp";

// The JSON-RPC 2.0 message bodies POST /mcp takes and answers with.
export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type None = Record<string, never>;

// Structured results are objects (MCP's structuredContent), so a list comes
// back as { items }.
interface Items<T> {
  items: T[];
}

// Partial update: what is omitted keeps its current value. secret follows
// CheckRequest: omitted keeps the stored one, "" removes it.
export type UpdateCheckInput = { id: string } & Partial<CheckRequest>;

// A template instance to remove, by its name (TemplateInstance.name).
// list_catalog_apps without detail: enough to pick an app and fill its
// inputs, without each entry's install source.
export interface CatalogAppSummary {
  id: string;
  name: string;
  summary: string;
  slots: CatalogSlot[];
  requires: string[];
  // DetectedApp.state, and its URLs when installed.
  installed: DetectState;
  urls: string[];
  inputs: CatalogInput[];
}

export interface RemoveTemplateAppInput {
  name: string;
  // Also delete its namespace and volumes. Default false: they stay.
  deleteVolumes?: boolean;
}

export interface McpTools {
  // --- read ------------------------------------------------------------------
  // GET /api/health/board
  get_health_board: { input: None; result: HealthBoard };
  // GET /api/health/categories/:category
  get_health_category: { input: { category: Category }; result: CategoryDetail };
  // GET /api/metrics-k8s/nodes
  list_nodes: { input: None; result: Items<NodeSummary> };
  // GET /api/workloads/namespaces
  list_namespaces: { input: None; result: Items<NamespaceView> };
  // GET /api/workloads/namespaces/:namespace/workloads; without namespace,
  // every namespace from GET /api/workloads/namespaces. Jobs that finished
  // successfully (WorkloadView.finished "complete") are left out unless
  // includeFinished.
  list_workloads: { input: { namespace?: string; includeFinished?: boolean }; result: Items<WorkloadView> };
  // GET /api/workloads/namespaces/:namespace/pods
  list_pods: { input: { namespace: string; workload?: string }; result: Items<PodView> };
  // GET /api/checks
  list_checks: { input: None; result: Items<CheckView> };
  // GET /api/health/links
  list_links: { input: { category?: Category }; result: Items<HealthLinkView> };
  // GET /api/backups/posture
  get_backup_posture: { input: None; result: BackupPosture };
  // GET /api/catalog/apps: CatalogAppSummary per app, the whole
  // CatalogAppView (install source, manifest included) with detail.
  list_catalog_apps: {
    input: { slot?: CatalogSlot; detail?: boolean };
    result: Items<CatalogAppSummary> | Items<CatalogAppView>;
  };
  // GET /api/catalog/discovery, with the published scheme from
  // GET /api/deploy/access: hosts the access mode serves over https
  // (AccessHost.url) get that url and edgeTls, and app URLs follow.
  get_discovery: { input: None; result: DiscoveryReport };
  // GET /api/deploy/jobs, newest first. limit: 1 to 100, default 20.
  list_deploy_jobs: { input: { appId?: string; limit?: number }; result: Items<DeployJobView> };
  // GET /api/deploy/jobs/:id/logs (redacted). tail: 1 to 2000 lines.
  get_deploy_job_logs: { input: { id: string; tail?: number }; result: LogLines };
  // GET /api/deploy/bundles, newest first.
  list_bundle_runs: { input: None; result: Items<BundleRunView> };
  // GET /api/hosts. Never carries a credential.
  list_hosts: { input: None; result: Items<HostView> };
  // GET /api/templates: the library and every deployed instance.
  list_templates: { input: None; result: TemplatesView };
  // GET /api/connector-entra/view
  get_entra_signin: { input: None; result: EntraSignInView };
  // GET /api/connector-entra/groups, by display name prefix.
  list_entra_groups: { input: { search?: string }; result: Items<EntraGroup> };
  // GET /api/connector-storage/targets. Never carries a credential.
  list_storage_targets: { input: None; result: Items<StorageTargetView> };
  // GET /api/backups/schedules
  get_backup_schedules: { input: None; result: BackupSchedulesView };
  // GET /api/backups/volumes/:uid/backups
  list_volume_backups: { input: { uid: string }; result: Items<VolumeRestorePoint> };

  // --- write (a "write" token) ----------------------------------------------
  // POST /api/checks
  create_check: { input: CheckRequest; result: CheckView };
  // GET /api/checks, then PUT /api/checks/:id with the merged request.
  update_check: { input: UpdateCheckInput; result: CheckView };
  // DELETE /api/checks/:id
  delete_check: { input: { id: string }; result: { ok: true } };
  // POST /api/checks/:id/run
  run_check: { input: { id: string }; result: CheckResult };
  // The checks page's "Accept this status": records the HTTP status the last
  // run failed or warned on as expected, then re-runs the check. Refused when
  // the last run did not fail on an HTTP status below 500.
  accept_check_status: { input: { id: string }; result: CheckView };
  // POST /api/health/links
  create_link: { input: HealthLinkRequest; result: HealthLinkView };
  // PUT /api/health/links/:id; custom links only.
  update_link: { input: { id: string } & Partial<HealthLinkRequest>; result: HealthLinkView };
  // DELETE /api/health/links/:id; custom links only.
  delete_link: { input: { id: string }; result: { ok: true } };
  // POST /api/deploy/plan; runs nothing.
  plan_app_deploy: { input: DeployRequest; result: DeployPlan };
  // POST /api/deploy/jobs
  deploy_app: { input: DeployJobRequest; result: DeployJobView };
  // POST /api/deploy/bundles/plan; runs nothing.
  plan_bundle: { input: BundleRequest; result: BundlePlan };
  // POST /api/deploy/bundles
  start_bundle: { input: BundleRequest; result: BundleRunView };
  // POST /api/templates/plan; runs nothing. The rendered manifests, guardrail
  // findings and the deploy runner's plan, as the Templates page previews.
  plan_template_deploy: { input: TemplateDeployRequest; result: TemplatePlan };
  // POST /api/templates/jobs. The guardrail's refusals stand: a request the
  // plan does not allow is a 400.
  deploy_template: { input: TemplateJobRequest; result: DeployJobView };
  // POST /api/deploy/actions/plan with a remove-app action; runs nothing.
  plan_template_removal: { input: RemoveTemplateAppInput; result: DeployActionPlan };
  // POST /api/deploy/actions/run with a remove-app action.
  remove_template_app: { input: RemoveTemplateAppInput; result: DeployJobView };
  // POST /api/connector-entra/signin
  setup_entra_signin: { input: EntraSignInRequest; result: EntraSignInView };
  // PUT /api/backups/target
  set_backup_target: { input: { connectorId: string | null }; result: DeployJobView };
  // GET /api/backups/schedules, then PUT /api/backups/schedules with this
  // group's schedule replaced (or added); the other groups stay.
  set_backup_schedule: { input: BackupSchedule; result: DeployJobView };
  // POST /api/backups/volumes/:uid/backup-now
  backup_volume_now: { input: { uid: string }; result: DeployJobView };
  // POST /api/backups/restore/plan; runs nothing.
  plan_volume_restore: { input: VolumeRestoreRequest; result: DeployActionPlan };
  // POST /api/backups/restore
  restore_volume: { input: VolumeRestoreRequest; result: DeployJobView };
}

export type McpToolName = keyof McpTools;

export interface McpToolSpec {
  name: McpToolName;
  title: string;
  // One or two sentences an agent reads to pick the tool.
  description: string;
  // The token scope that lists and allows it.
  scope: ApiTokenScope;
  // Changes nothing outside this app's reads.
  readOnly: boolean;
  // Removes or replaces something.
  destructive: boolean;
}

// Every tool, in the order clients list them.
export const MCP_TOOLS: readonly McpToolSpec[] = [
  {
    name: "get_health_board",
    title: "Health board",
    description:
      "Overall status and one tile per category (cluster, storage, backups, gitops, hosts, checks) with its worst issue.",
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "get_health_category",
    title: "Health category",
    description: "Every provider and check result in one category, with the native UI links for it.",
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "list_nodes",
    title: "Nodes",
    description: "Kubernetes nodes with readiness, roles, CPU and memory use.",
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "list_namespaces",
    title: "Namespaces",
    description: "Namespaces with workload and pod counts and unhealthy pods.",
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "list_workloads",
    title: "Workloads",
    description:
      "Deployments, StatefulSets, DaemonSets, Jobs and CronJobs with readiness and images, in one namespace or all; finished Jobs only with includeFinished.",
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "list_pods",
    title: "Pods",
    description: "Pods in a namespace, optionally only one workload's, with phase, restarts and containers.",
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "list_checks",
    title: "HTTP and TCP checks",
    description: "Every HTTP/TCP check with its settings and last result.",
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "list_links",
    title: "Links",
    description: "Links shown on the category pages: settings links (read-only) and custom ones.",
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "get_backup_posture",
    title: "Backup posture",
    description: "Every PVC with whether and how it is backed up, last backup age and restore-test marks.",
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "list_catalog_apps",
    title: "App catalog",
    description:
      "Apps that can be deployed, their inputs, and whether discovery found each installed; detail for the install source.",
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "get_discovery",
    title: "Discovery",
    description: "What the cluster already has: installed catalog apps, Ingress hosts, missing cluster basics.",
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "list_deploy_jobs",
    title: "Recent deploys",
    description: "Deploy jobs, newest first, optionally for one app.",
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "get_deploy_job_logs",
    title: "Deploy logs",
    description: "A deploy job's log, with secret values redacted.",
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "list_bundle_runs",
    title: "Bundle runs",
    description: "Bundle rollouts, newest first, with each step's state.",
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "list_hosts",
    title: "Hosts",
    description: "SSH-monitored hosts (servers, NAS) with status and facts.",
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "list_templates",
    title: "Templates",
    description:
      "The app template library (plus the Custom app template) and every app deployed from it, with its address and latest job.",
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "get_entra_signin",
    title: "Entra sign-in",
    description:
      "Whether sign-in through Microsoft Entra ID is set up: the connector, the app registration this install owns, and what blocks setup.",
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "list_entra_groups",
    title: "Entra groups",
    description:
      "Security groups in the Entra tenant by display name prefix, with the object ids setup_entra_signin takes as adminGroups.",
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "list_storage_targets",
    title: "Storage targets",
    description:
      "Every backup destination (NFS export, S3/MinIO bucket, SMB share) with its reachability checks and what uses it, such as Longhorn's backup target. Never shows a credential.",
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "get_backup_schedules",
    title: "Backup schedules",
    description:
      'Longhorn\'s recurring snapshot and backup schedule per volume group ("default" covers every volume in no other group), or the suggested ones while none is set.',
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "list_volume_backups",
    title: "A volume's backups",
    description:
      "The backups of one volume on the backup target, newest first, by the PVC's uid from get_backup_posture: the restore points restore_volume takes.",
    scope: "read",
    readOnly: true,
    destructive: false,
  },
  {
    name: "create_check",
    title: "Add a check",
    description: "Adds an HTTP or TCP check that shows up on the Checks page and the health board.",
    scope: "write",
    readOnly: false,
    destructive: false,
  },
  {
    name: "update_check",
    title: "Change a check",
    description: "Changes the given fields of a check; the rest keep their values.",
    scope: "write",
    readOnly: false,
    destructive: false,
  },
  {
    name: "delete_check",
    title: "Delete a check",
    description: "Deletes a check and its stored secret.",
    scope: "write",
    readOnly: false,
    destructive: true,
  },
  {
    name: "run_check",
    title: "Run a check now",
    description: "Runs a check immediately and returns the result.",
    scope: "write",
    readOnly: false,
    destructive: false,
  },
  {
    name: "accept_check_status",
    title: "Accept a check's status",
    description:
      "Records the HTTP status a check last failed or warned on as expected (a login page's 401, say) and re-runs it.",
    scope: "write",
    readOnly: false,
    destructive: false,
  },
  {
    name: "create_link",
    title: "Add a link",
    description: "Adds a link to a tool's UI on a category page (cluster, storage, apps...).",
    scope: "write",
    readOnly: false,
    destructive: false,
  },
  {
    name: "update_link",
    title: "Change a link",
    description: "Changes a custom link's category, label or URL.",
    scope: "write",
    readOnly: false,
    destructive: false,
  },
  {
    name: "delete_link",
    title: "Delete a link",
    description: "Deletes a custom link.",
    scope: "write",
    readOnly: false,
    destructive: true,
  },
  {
    name: "plan_app_deploy",
    title: "Preview an app deploy",
    description:
      "Resolves defaults and validates inputs for deploying a catalog app; shows commands and values; runs nothing.",
    scope: "write",
    readOnly: true,
    destructive: false,
  },
  {
    name: "deploy_app",
    title: "Deploy an app",
    description:
      "Starts a deploy job for a catalog app (mode install, or dry-run to render only). Preview with plan_app_deploy first.",
    scope: "write",
    readOnly: false,
    destructive: false,
  },
  {
    name: "plan_bundle",
    title: "Preview a bundle",
    description: "Every step of a bundle rollout with what would be skipped; runs nothing.",
    scope: "write",
    readOnly: true,
    destructive: false,
  },
  {
    name: "start_bundle",
    title: "Roll out a bundle",
    description:
      "Starts a bundle rollout, one deploy job per app, stopping at the first failure. Preview with plan_bundle first.",
    scope: "write",
    readOnly: false,
    destructive: false,
  },
  {
    name: "plan_template_deploy",
    title: "Preview a template deploy",
    description:
      "Renders a template or custom app (image, port, env, volume) into manifests and checks them against the guardrail (no host paths, host networking, privileged containers, extra capabilities or admin role bindings); runs nothing.",
    scope: "write",
    readOnly: true,
    destructive: false,
  },
  {
    name: "deploy_template",
    title: "Deploy a template",
    description:
      "Starts a deploy job for a template or custom app in its own namespace (mode install, or dry-run). Refused when the guardrail or the plan blocks it. Preview with plan_template_deploy first.",
    scope: "write",
    readOnly: false,
    destructive: false,
  },
  {
    name: "plan_template_removal",
    title: "Preview removing a template app",
    description:
      "What removing an app deployed from a template would delete, and which volumes stay or go; runs nothing.",
    scope: "write",
    readOnly: true,
    destructive: false,
  },
  {
    name: "remove_template_app",
    title: "Remove a template app",
    description:
      "Deletes an app deployed from a template and its HTTP check. Its namespace and volumes stay unless deleteVolumes is true, which deletes its data for good. Preview with plan_template_removal first.",
    scope: "write",
    readOnly: false,
    destructive: true,
  },
  {
    name: "setup_entra_signin",
    title: "Set up Entra sign-in",
    description:
      "Creates (or reuses) the Entra app registration this install signs in through and switches OIDC sign-in to it. adminGroups are group object ids from list_entra_groups. Needs an https public URL.",
    scope: "write",
    readOnly: false,
    destructive: false,
  },
  {
    name: "set_backup_target",
    title: "Set the backup target",
    description:
      "Points Longhorn's backup target at a storage target from list_storage_targets (with its credential Secret), or clears it with null. Starts a deploy job.",
    scope: "write",
    readOnly: false,
    destructive: false,
  },
  {
    name: "set_backup_schedule",
    title: "Set a backup schedule",
    description:
      "Sets one volume group's recurring snapshot and backup crons and how many of each to keep; other groups stay as they are. A cron left out turns that half off. Starts a deploy job.",
    scope: "write",
    readOnly: false,
    destructive: false,
  },
  {
    name: "backup_volume_now",
    title: "Back up a volume now",
    description: "Snapshots one Longhorn volume (by PVC uid) and backs it up to the target now. Starts a deploy job.",
    scope: "write",
    readOnly: false,
    destructive: false,
  },
  {
    name: "plan_volume_restore",
    title: "Preview a volume restore",
    description:
      "What restoring a backup from list_volume_backups would do: to a new PVC beside the old one (default), or in place with the app scaled down meanwhile; runs nothing.",
    scope: "write",
    readOnly: true,
    destructive: false,
  },
  {
    name: "restore_volume",
    title: "Restore a volume",
    description:
      "Restores a backup to a new PVC, or in place (mode in-place), which stops the app and replaces the volume's current data with the backup's. Preview with plan_volume_restore first.",
    scope: "write",
    readOnly: false,
    destructive: true,
  },
];

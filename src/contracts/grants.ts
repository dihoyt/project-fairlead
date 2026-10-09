// What an API token may reach beyond its read/write scope: product areas and
// namespaces. Every ApiRoutes key has an entry in ROUTE_ACCESS (a missing one
// is a compile error) saying which area it belongs to and, for a route that
// acts on one namespace, where that namespace is read from. The runtime
// checks a token's grant against it before any module handler runs, so REST
// and MCP (whose tools go through ModuleContext.call) are judged the same way.
//
// Server-free on purpose: the client builds its pickers from here.

import type { RouteKey } from "./api.js";
import type { ApiTokenScope } from "./auth.js";
import type { McpToolName } from "./mcp.js";

export type TokenArea =
  "health" | "checks" | "workloads" | "backups" | "nodes" | "deploy" | "notify" | "connectors" | "hosts";

export const TOKEN_AREAS: readonly TokenArea[] = [
  "health",
  "checks",
  "workloads",
  "backups",
  "nodes",
  "deploy",
  "notify",
  "connectors",
  "hosts",
];

export const TOKEN_AREA_LABELS: Record<TokenArea, string> = {
  health: "Health board and links",
  checks: "HTTP checks",
  workloads: "Workloads, pods and logs",
  backups: "Backups and storage",
  nodes: "Nodes, metrics and cluster join",
  deploy: "Apps, catalog and templates",
  notify: "Notifications",
  connectors: "Connectors",
  hosts: "Hosts",
};

// A token's reach. Omitted namespaces or areas: all of them, which is what
// every token made before grants existed has. When present, each list has at
// least one entry; namespaces are exact names.
export interface ApiTokenGrant {
  scope: ApiTokenScope;
  namespaces?: string[];
  areas?: TokenArea[];
}

// Where a namespaced route's namespace comes from: a path param, a query
// parameter or a top-level body field, by name.
export type NamespaceSource = { param: string } | { query: string } | { body: string };

// How a route is reached:
// - { area, namespace? }: a token needs `area` in its grant. With `namespace`
//   and a value present on the request, a namespace-limited token needs that
//   namespace. Without one (or with the value missing) the route is
//   cluster-wide: a namespace-limited token may read it (GET) but never
//   anything else.
// - "open": any token; the route shows nothing an area guards.
// - "full": only a token with every area and every namespace.
// - "session": never a token (also refused by the platform ahead of routing).
// - "public": no identity at all.
export type RouteAccess = { area: TokenArea; namespace?: NamespaceSource } | "open" | "full" | "session" | "public";

const a = (area: TokenArea, namespace?: NamespaceSource): RouteAccess => (namespace ? { area, namespace } : { area });
const nsParam: NamespaceSource = { param: "namespace" };
const nsBody: NamespaceSource = { body: "namespace" };

export const ROUTE_ACCESS: { [K in RouteKey]: RouteAccess } = {
  "GET /healthz": "public",
  "GET /livez": "public",
  "GET /api/system/modules": "open",
  "GET /api/system/jobs": "open",
  "POST /api/system/reset": "full",

  "GET /api/me": "open",
  "GET /api/auth/methods": "session",
  "POST /api/auth/login": "session",
  "POST /api/auth/logout": "session",
  "POST /api/auth/password": "session",
  "GET /api/auth/account": "session",
  "POST /api/auth/totp/verify": "session",
  "GET /api/auth/totp/status": "session",
  "POST /api/auth/totp/enroll": "session",
  "POST /api/auth/totp/confirm": "session",
  "POST /api/auth/totp/disable": "session",
  "POST /api/auth/totp/recovery-codes": "session",
  "GET /api/admin/overview": "session",
  "PUT /api/admin/settings/:key": "session",
  "DELETE /api/admin/settings/:key": "session",
  "PUT /api/admin/oidc/secret": "session",
  "POST /api/admin/oidc/test": "session",
  "GET /api/admin/oidc/authentik": "session",
  "POST /api/admin/oidc/authentik": "session",
  "GET /api/admin/oidc/pocket-id": "session",
  "POST /api/admin/oidc/pocket-id": "session",
  "POST /api/admin/oidc/public": "session",
  "GET /api/admin/users": "session",
  "POST /api/admin/users": "session",
  "PATCH /api/admin/users/:id": "session",
  "DELETE /api/admin/users/:id": "session",
  "POST /api/admin/users/:id/password": "session",
  "POST /api/admin/users/:id/totp/reset": "session",
  "GET /api/admin/users/:id/sessions": "session",
  "DELETE /api/admin/users/:id/sessions": "session",
  "DELETE /api/admin/users/:id/sessions/:handle": "session",
  "DELETE /api/admin/users/:id/identities": "session",
  "GET /api/admin/audit": "session",
  "GET /api/admin/tokens": "session",
  "POST /api/admin/tokens": "session",
  "PATCH /api/admin/tokens/:id": "session",
  "DELETE /api/admin/tokens/:id": "session",
  "POST /api/admin/oauth/consent": "session",

  "GET /api/k8s/capabilities": "open",

  "GET /api/health/board": a("health"),
  "GET /api/health/categories/:category": a("health"),
  "GET /api/health/history/:providerId/:checkId": a("health"),
  "POST /api/health/providers/:providerId/run": a("health"),
  "GET /api/health/links": a("health"),
  "POST /api/health/links": a("health"),
  "PUT /api/health/links/:id": a("health"),
  "DELETE /api/health/links/:id": a("health"),

  "GET /api/cluster/join": a("nodes"),
  "POST /api/cluster/join-links": a("nodes"),
  "DELETE /api/cluster/join-links/:id": a("nodes"),
  "GET /join/:token": "public",

  "GET /api/metrics/query": a("nodes"),
  "GET /api/metrics/series": a("nodes"),

  "GET /api/notify/channels": a("notify"),
  "POST /api/notify/channels": a("notify"),
  "PUT /api/notify/channels/:id": a("notify"),
  "DELETE /api/notify/channels/:id": a("notify"),
  "POST /api/notify/channels/:id/test": a("notify"),
  "GET /api/notify/email/setup": a("notify"),
  // A person signing in to a mailbox in their browser, never a token.
  "POST /api/notify/channels/:id/oauth": "session",
  "GET /api/notify/oauth/callback": "session",

  "GET /api/hosts": a("hosts"),
  "POST /api/hosts": a("hosts"),
  "GET /api/hosts/:id": a("hosts"),
  "PUT /api/hosts/:id": a("hosts"),
  "DELETE /api/hosts/:id": a("hosts"),
  "POST /api/hosts/test": a("hosts"),
  "GET /api/hosts/keypair": a("hosts"),
  "POST /api/hosts/keypair": a("hosts"),

  "GET /api/checks": a("checks"),
  "POST /api/checks": a("checks"),
  "PUT /api/checks/:id": a("checks"),
  "DELETE /api/checks/:id": a("checks"),
  "POST /api/checks/:id/run": a("checks"),

  "GET /api/metrics-k8s/nodes": a("nodes"),

  "GET /api/longhorn/replicas": a("backups"),

  "GET /api/backups/posture": a("backups"),
  "GET /api/backups/posture.csv": a("backups"),
  "POST /api/backups/volumes/:uid/restore-tests": a("backups"),
  "GET /api/backups/target": a("backups"),
  "PUT /api/backups/target": a("backups"),
  "GET /api/backups/schedules": a("backups"),
  "PUT /api/backups/schedules": a("backups"),
  "PUT /api/backups/volumes/:uid/groups": a("backups"),
  "POST /api/backups/volumes/:uid/backup-now": a("backups"),
  "GET /api/backups/volumes/:uid/backups": a("backups"),
  "POST /api/backups/restore/plan": a("backups"),
  "POST /api/backups/restore": a("backups"),

  "GET /api/workloads/links": a("workloads"),
  "GET /api/workloads/namespaces": a("workloads"),
  "GET /api/workloads/namespaces/:namespace/workloads": a("workloads", nsParam),
  "GET /api/workloads/namespaces/:namespace/pods": a("workloads", nsParam),
  "GET /api/workloads/namespaces/:namespace/pods/:pod": a("workloads", nsParam),
  "GET /api/workloads/namespaces/:namespace/events": a("workloads", nsParam),
  "GET /api/workloads/usage": a("workloads"),
  "GET /api/workloads/namespaces/:namespace/usage": a("workloads", nsParam),
  "GET /api/workloads/namespaces/:namespace/pods/:pod/logs": a("workloads", nsParam),
  "GET /api/workloads/namespaces/:namespace/pods/:pod/logs/stream": a("workloads", nsParam),

  "GET /api/catalog/apps": a("deploy"),
  "GET /api/catalog/apps/:id": a("deploy"),
  "GET /api/catalog/discovery": a("deploy"),
  "GET /api/catalog/bundles": a("deploy"),

  "GET /api/deploy/status": a("deploy"),
  "GET /api/deploy/access": a("deploy"),
  "PUT /api/deploy/access": a("deploy"),
  "POST /api/deploy/plan": a("deploy", nsBody),
  "POST /api/deploy/jobs": a("deploy", nsBody),
  "GET /api/deploy/jobs": a("deploy"),
  "GET /api/deploy/jobs/:id": a("deploy"),
  "GET /api/deploy/jobs/:id/logs": a("deploy"),
  "GET /api/deploy/jobs/:id/logs/stream": a("deploy"),
  "POST /api/deploy/jobs/:id/cancel": a("deploy"),
  "POST /api/deploy/bundles/plan": a("deploy"),
  "POST /api/deploy/bundles": a("deploy"),
  "GET /api/deploy/bundles": a("deploy"),
  "GET /api/deploy/bundles/:id": a("deploy"),
  "POST /api/deploy/bundles/:id/cancel": a("deploy"),
  "GET /api/deploy/upgrades": a("deploy"),
  "POST /api/deploy/upgrades": a("deploy"),
  "GET /api/deploy/gate": a("deploy"),
  "GET /api/deploy/ports": a("deploy"),
  "POST /api/deploy/actions/plan": a("deploy"),
  "POST /api/deploy/actions/run": a("deploy"),
  "GET /api/deploy/actions/backups/:id": a("backups"),
  "GET /api/deploy/actions/backups/:id/files/:claim": a("backups"),
  "POST /api/deploy/actions/backups/:id/done": a("backups"),

  "GET /api/templates": a("deploy"),
  "POST /api/templates/plan": a("deploy"),
  "POST /api/templates/jobs": a("deploy"),

  // The transport only: each tool's routes are judged on their own.
  "POST /api/mcp": "open",
  "GET /api/mcp": "open",
  "DELETE /api/mcp": "open",

  "GET /api/connectors/kinds": a("connectors"),
  "GET /api/connectors": a("connectors"),
  "POST /api/connectors": a("connectors"),
  "POST /api/connectors/test": a("connectors"),
  "GET /api/connectors/:id": a("connectors"),
  "PUT /api/connectors/:id": a("connectors"),
  "DELETE /api/connectors/:id": a("connectors"),
  "POST /api/connectors/:id/test": a("connectors"),
  "POST /api/connectors/:id/reconcile": a("connectors"),
  "GET /api/connector-cloudflare/view": a("connectors"),
  "POST /api/connector-cloudflare/sync": a("connectors"),
  "PUT /api/connector-cloudflare/hosts/:host": a("connectors"),
  "POST /api/connector-cloudflare/discover": a("connectors"),
  "POST /api/connector-cloudflare/tunnel": a("connectors"),
  "POST /api/connector-cloudflare/tunnel/deploy": a("connectors"),
  "GET /api/connector-entra/view": a("connectors"),
  "GET /api/connector-entra/certificate": a("connectors"),
  "POST /api/connector-entra/signin": a("connectors"),
  "GET /api/connector-entra/groups": a("connectors"),
  "GET /api/connector-storage/targets": a("connectors"),
  "GET /api/connector-storage/targets/:id": a("connectors"),

  "GET /api/onboarding/state": "open",
  "POST /api/onboarding/steps/:step": "full",
  "GET /api/onboarding/seed": "open",
  "POST /api/onboarding/seed/apply": "session",
  "POST /api/onboarding/seed/dismiss": "session",
};

// The route each MCP tool is listed by: tools/list shows a tool only when
// grantReaches() its route.
export const MCP_TOOL_ROUTES: { [K in McpToolName]: RouteKey } = {
  get_health_board: "GET /api/health/board",
  get_health_category: "GET /api/health/categories/:category",
  list_nodes: "GET /api/metrics-k8s/nodes",
  list_namespaces: "GET /api/workloads/namespaces",
  list_workloads: "GET /api/workloads/namespaces/:namespace/workloads",
  list_pods: "GET /api/workloads/namespaces/:namespace/pods",
  list_checks: "GET /api/checks",
  list_links: "GET /api/health/links",
  get_backup_posture: "GET /api/backups/posture",
  list_catalog_apps: "GET /api/catalog/apps",
  get_discovery: "GET /api/catalog/discovery",
  list_deploy_jobs: "GET /api/deploy/jobs",
  get_deploy_job_logs: "GET /api/deploy/jobs/:id/logs",
  list_bundle_runs: "GET /api/deploy/bundles",
  list_hosts: "GET /api/hosts",
  list_templates: "GET /api/templates",
  get_entra_signin: "GET /api/connector-entra/view",
  list_entra_groups: "GET /api/connector-entra/groups",
  list_storage_targets: "GET /api/connector-storage/targets",
  get_backup_schedules: "GET /api/backups/schedules",
  list_volume_backups: "GET /api/backups/volumes/:uid/backups",
  create_check: "POST /api/checks",
  update_check: "PUT /api/checks/:id",
  delete_check: "DELETE /api/checks/:id",
  run_check: "POST /api/checks/:id/run",
  accept_check_status: "PUT /api/checks/:id",
  create_link: "POST /api/health/links",
  update_link: "PUT /api/health/links/:id",
  delete_link: "DELETE /api/health/links/:id",
  plan_app_deploy: "POST /api/deploy/plan",
  deploy_app: "POST /api/deploy/jobs",
  plan_bundle: "POST /api/deploy/bundles/plan",
  start_bundle: "POST /api/deploy/bundles",
  plan_template_deploy: "POST /api/templates/plan",
  deploy_template: "POST /api/templates/jobs",
  plan_template_removal: "POST /api/deploy/actions/plan",
  remove_template_app: "POST /api/deploy/actions/run",
  setup_entra_signin: "POST /api/connector-entra/signin",
  set_backup_target: "PUT /api/backups/target",
  set_backup_schedule: "PUT /api/backups/schedules",
  backup_volume_now: "POST /api/backups/volumes/:uid/backup-now",
  plan_volume_restore: "POST /api/backups/restore/plan",
  restore_volume: "POST /api/backups/restore",
  // Node actions run as deploy actions, so they need the deploy area.
  plan_node_action: "POST /api/deploy/actions/plan",
  cordon_node: "POST /api/deploy/actions/run",
  uncordon_node: "POST /api/deploy/actions/run",
  drain_node: "POST /api/deploy/actions/run",
  reboot_node: "POST /api/deploy/actions/run",
};

export function grantAllowsArea(grant: ApiTokenGrant, area: TokenArea): boolean {
  return grant.areas === undefined || grant.areas.includes(area);
}

export function grantAllowsNamespace(grant: ApiTokenGrant, namespace: string): boolean {
  return grant.namespaces === undefined || grant.namespaces.includes(namespace);
}

// The namespaces a grant may see; null: every one.
export function grantNamespaces(grant: ApiTokenGrant | undefined): readonly string[] | null {
  return grant?.namespaces ?? null;
}

export interface RouteRequest {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}

// The namespace a request names for a route, or undefined for a route that
// isn't namespaced or a request that leaves it out.
export function routeNamespace(key: RouteKey, request: RouteRequest): string | undefined {
  const access = ROUTE_ACCESS[key];
  if (typeof access === "string" || access.namespace === undefined) return undefined;
  const source = access.namespace;
  let value: unknown;
  if ("param" in source) value = request.params?.[source.param];
  else if ("query" in source) value = request.query?.[source.query];
  else if (request.body !== null && typeof request.body === "object") {
    value = (request.body as Record<string, unknown>)[source.body];
  }
  return typeof value === "string" && value !== "" ? value : undefined;
}

const isRead = (key: RouteKey) => key.startsWith("GET ");

// Why a grant may not make this request, one sentence; null when it may.
// The scope (read or write) is not judged here: can() caps it as before.
export function grantRefusal(grant: ApiTokenGrant, key: RouteKey, request: RouteRequest = {}): string | null {
  const access = ROUTE_ACCESS[key];
  if (access === "public" || access === "open") return null;
  if (access === "session") return "API tokens cannot be used here; sign in instead.";
  if (access === "full") {
    return grant.areas === undefined && grant.namespaces === undefined
      ? null
      : "This needs a token with every area and every namespace.";
  }
  if (!grantAllowsArea(grant, access.area)) {
    return `This token's grant doesn't include ${TOKEN_AREA_LABELS[access.area]}.`;
  }
  if (grant.namespaces === undefined) return null;
  const namespace = routeNamespace(key, request);
  if (namespace !== undefined) {
    return grantAllowsNamespace(grant, namespace) ? null : `This token doesn't reach namespace "${namespace}".`;
  }
  return isRead(key) ? null : "This token is limited to namespaces, so it can't change anything cluster-wide.";
}

// Whether some request to this route could pass the grant: its area is
// allowed, and a namespace-limited grant either reads it or can name one of
// its namespaces.
export function grantReaches(grant: ApiTokenGrant, key: RouteKey): boolean {
  const access = ROUTE_ACCESS[key];
  if (typeof access === "string") return grantRefusal(grant, key) === null;
  if (!grantAllowsArea(grant, access.area)) return false;
  return grant.namespaces === undefined || isRead(key) || access.namespace !== undefined;
}

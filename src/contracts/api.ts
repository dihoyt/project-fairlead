// Every Milestone A HTTP route: method and path, path params, query, body
// and response. Mocks for every response are in ./mocks/api.ts, and the
// type of that object makes a route without a mock a compile error.
//
// Server-free on purpose: the client imports this file.

import type {
  AccountView,
  AdminOverview,
  ApiTokenView,
  AuditRow,
  AuthentikWirePlan,
  AuthentikWireRequest,
  AuthentikWireResult,
  AuthMethods,
  LoginResponse,
  Me,
  NewApiToken,
  NewApiTokenRequest,
  NewUserRequest,
  SessionView,
  SettingValue,
  TotpEnrollment,
  TotpStatus,
  TotpVerifyRequest,
  UserChangesRequest,
  UserView,
} from "./auth.js";
import type { BackupPosture, RestoreTestMark } from "./backups.js";
import type { CatalogAppView, CatalogBundleView, DiscoveryReport } from "./catalog.js";
import type { CheckRequest, CheckView } from "./checks.js";
import type { JoinLink, JoinLinkRequest, JoinStatus } from "./cluster.js";
import type {
  AccessRequest,
  AccessView,
  BundlePlan,
  BundleRequest,
  BundleRunView,
  DeployJobRequest,
  DeployJobView,
  DeployPlan,
  DeployRequest,
  DeployStatus,
} from "./deploy.js";
import type {
  Category,
  CategoryDetail,
  CheckHistory,
  CheckResult,
  HealthBoard,
  HealthLinkRequest,
  HealthLinkView,
} from "./health.js";
import type { HostKeypair, HostRequest, HostTestResult, HostView } from "./hosts.js";
import type { CapabilityReport } from "./k8s.js";
import type { JsonRpcMessage } from "./mcp.js";
import type { NodeSummary, SeriesInfo, SeriesResult } from "./metrics.js";
import type { ChannelRequest, ChannelView, TestSendResult } from "./notify.js";
import type { OnboardingState, OnboardingStepId } from "./onboarding.js";
import type { ResetRequest, ResetResult } from "./reset.js";
import type { Draining, Healthz, JobsView, ModuleStatus } from "./system.js";
import type { EventView, LogLines, NamespaceView, PodView, WorkloadLinks, WorkloadView } from "./workloads.js";

type None = Record<string, never>;

export interface Route<Params = None, Query = None, Body = None, Res = unknown> {
  params: Params;
  query: Query;
  body: Body;
  response: Res;
}

// A text/event-stream whose every `data:` line is one JSON-encoded T.
export interface EventStream<T> {
  readonly eventStream: T;
}

// A non-JSON body (CSV export).
export interface TextBody<Type extends string> {
  readonly contentType: Type;
}

// Every error response, any route: { error } with a 4xx/5xx status.
export interface ApiError {
  error: string;
}

export interface Ok {
  ok: true;
}

export interface ApiRoutes {
  // --- runtime (S1) -------------------------------------------------------
  // Unauthenticated probes. /healthz is readiness and answers 503 Draining
  // during a drain; /livez always answers 200.
  "GET /healthz": Route<None, None, None, Healthz | Draining>;
  "GET /livez": Route<None, None, None, { status: "ok" }>;
  "GET /api/system/modules": Route<None, None, None, ModuleStatus[]>;
  // Admin only.
  "GET /api/system/jobs": Route<None, None, None, JobsView>;
  // Admin only. Clears the chosen scopes in one transaction (secrets after
  // it commits), audits the reset, and answers 400 unless confirm is
  // RESET. A scope no loaded module provides is skipped, not an error.
  "POST /api/system/reset": Route<None, None, ResetRequest, ResetResult>;

  // --- platform (S2), same shapes as code-console --------------------------
  // Browser navigations, not JSON: GET /auth/oidc/start[?link=1] and
  // GET /auth/oidc/callback redirect.
  "GET /api/me": Route<None, None, None, Me>;
  "GET /api/auth/methods": Route<None, None, None, AuthMethods>;
  "POST /api/auth/login": Route<None, None, { username: string; password: string }, LoginResponse>;
  "POST /api/auth/logout": Route<None, None, None, Ok>;
  "POST /api/auth/password": Route<None, None, { current: string; next: string }, Ok>;
  "GET /api/auth/account": Route<None, None, None, AccountView>;
  "POST /api/auth/totp/verify": Route<None, None, TotpVerifyRequest, { mustChangePassword: boolean }>;
  "GET /api/auth/totp/status": Route<None, None, None, TotpStatus>;
  "POST /api/auth/totp/enroll": Route<None, None, None, TotpEnrollment>;
  "POST /api/auth/totp/confirm": Route<None, None, { code: string }, { recoveryCodes: string[] }>;
  "POST /api/auth/totp/disable": Route<None, None, { password?: string; code?: string }, Ok>;
  "POST /api/auth/totp/recovery-codes": Route<None, None, { code: string }, { recoveryCodes: string[] }>;
  "GET /api/admin/overview": Route<None, None, None, AdminOverview>;
  "PUT /api/admin/settings/:key": Route<
    { key: string },
    None,
    { value: SettingValue },
    { key: string; value: SettingValue }
  >;
  "DELETE /api/admin/settings/:key": Route<{ key: string }, None, None, { key: string; value: SettingValue }>;
  "PUT /api/admin/oidc/secret": Route<None, None, { value: string }, { hasSecret: boolean }>;
  "POST /api/admin/oidc/test": Route<None, None, None, { ok: boolean; issuer?: string; error?: string }>;
  // Admin. 400 for a missing or non-http(s) url.
  "GET /api/admin/oidc/authentik": Route<None, { url: string }, None, AuthentikWirePlan>;
  // Admin, audited (never with the token or secret). Creates or reuses the
  // provider and application, saves auth.oidc.{issuer,clientId,label,enabled}
  // (and adminGroups when given) and the client secret. 400: bad url, no
  // token given or stored, no public URL; 409: SECRETS_KEY not set; 502:
  // Authentik unreachable, refused the token, or answered unexpectedly, with
  // its status in the error.
  "POST /api/admin/oidc/authentik": Route<None, None, AuthentikWireRequest, AuthentikWireResult>;
  "GET /api/admin/users": Route<None, None, None, UserView[]>;
  "POST /api/admin/users": Route<None, None, NewUserRequest, { user: UserView; temporaryPassword: string | null }>;
  "PATCH /api/admin/users/:id": Route<{ id: string }, None, UserChangesRequest, UserView>;
  "DELETE /api/admin/users/:id": Route<{ id: string }, None, None, Ok>;
  "POST /api/admin/users/:id/password": Route<{ id: string }, None, None, { temporaryPassword: string }>;
  "POST /api/admin/users/:id/totp/reset": Route<{ id: string }, None, None, Ok>;
  "GET /api/admin/users/:id/sessions": Route<{ id: string }, None, None, SessionView[]>;
  "DELETE /api/admin/users/:id/sessions": Route<{ id: string }, None, None, { ended: number }>;
  "DELETE /api/admin/users/:id/sessions/:handle": Route<{ id: string; handle: string }, None, None, Ok>;
  "DELETE /api/admin/users/:id/identities": Route<{ id: string }, None, { provider: string }, UserView>;
  "GET /api/admin/audit": Route<None, { limit?: string; before?: string }, None, AuditRow[]>;
  // API tokens (see ApiTokenView). Admin with a signed-in session, audited;
  // a request carrying a token is refused here like everywhere under
  // /api/admin. Newest first; revoked tokens are gone.
  "GET /api/admin/tokens": Route<None, None, None, ApiTokenView[]>;
  // 400 for an empty name (over 80 characters) or an expiry outside 1-3650 days.
  "POST /api/admin/tokens": Route<None, None, NewApiTokenRequest, NewApiToken>;
  // Revokes at once: the next request with it is a 401. Unknown id: 404.
  "DELETE /api/admin/tokens/:id": Route<{ id: string }, None, None, Ok>;

  // --- k8s (A1) -----------------------------------------------------------
  "GET /api/k8s/capabilities": Route<None, { refresh?: "1" }, None, CapabilityReport>;

  // --- health (A2) --------------------------------------------------------
  "GET /api/health/board": Route<None, None, None, HealthBoard>;
  "GET /api/health/categories/:category": Route<{ category: Category }, None, None, CategoryDetail>;
  // from/to: ISO 8601; default the last 24h.
  "GET /api/health/history/:providerId/:checkId": Route<
    { providerId: string; checkId: string },
    { from?: string; to?: string },
    None,
    CheckHistory
  >;
  // Runs the provider now (write): results as collect() returned them.
  "POST /api/health/providers/:providerId/run": Route<{ providerId: string }, None, None, CheckResult[]>;
  // Settings links first (by category order), then custom ones oldest first.
  "GET /api/health/links": Route<None, { category?: Category }, None, HealthLinkView[]>;
  // Write, audited. 400 for an unknown category, a label outside 1-80
  // characters or a URL that isn't http(s).
  "POST /api/health/links": Route<None, None, HealthLinkRequest, HealthLinkView>;
  // Write, audited. Omitted fields keep their value. 404 for an unknown id;
  // 409 for a settings link (change those in the Links step or settings).
  "PUT /api/health/links/:id": Route<{ id: string }, None, Partial<HealthLinkRequest>, HealthLinkView>;
  "DELETE /api/health/links/:id": Route<{ id: string }, None, None, Ok>;

  // --- cluster (A5): adding nodes -----------------------------------------
  "GET /api/cluster/join": Route<None, None, None, JoinStatus>;
  // Admin, audited. 409 unless GET /api/cluster/join says "on"; 400 for a
  // role it doesn't list or a baseUrl that isn't http(s).
  "POST /api/cluster/join-links": Route<None, None, JoinLinkRequest, JoinLink>;
  // Admin, audited. Revokes an unused link; a used or unknown one is a 404.
  "DELETE /api/cluster/join-links/:id": Route<{ id: string }, None, None, Ok>;
  // Public (see PUBLIC_ROUTES): no session, rate-limited. The join script
  // for an unused, unexpired link, which this request uses up; 404 for any
  // other token, with the same body whether it never existed, expired or
  // was used. Cache-Control: no-store.
  "GET /join/:token": Route<{ token: string }, None, None, TextBody<"text/x-shellscript">>;

  // --- metrics (A3) -------------------------------------------------------
  // q: JSON-encoded SeriesQuery[]. One SeriesResult per matching label set.
  "GET /api/metrics/query": Route<None, { q: string }, None, SeriesResult[]>;
  "GET /api/metrics/series": Route<None, { prefix?: string }, None, SeriesInfo[]>;

  // --- notify (A4) --------------------------------------------------------
  "GET /api/notify/channels": Route<None, None, None, ChannelView[]>;
  "POST /api/notify/channels": Route<None, None, ChannelRequest, ChannelView>;
  "PUT /api/notify/channels/:id": Route<{ id: string }, None, ChannelRequest, ChannelView>;
  "DELETE /api/notify/channels/:id": Route<{ id: string }, None, None, Ok>;
  "POST /api/notify/channels/:id/test": Route<{ id: string }, None, None, TestSendResult>;

  // --- hosts (A9) ---------------------------------------------------------
  "GET /api/hosts": Route<None, None, None, HostView[]>;
  "POST /api/hosts": Route<None, None, HostRequest, HostView>;
  "GET /api/hosts/:id": Route<{ id: string }, None, None, HostView>;
  "PUT /api/hosts/:id": Route<{ id: string }, None, HostRequest, HostView>;
  "DELETE /api/hosts/:id": Route<{ id: string }, None, None, Ok>;
  // Connects with the given (unsaved) settings; nothing is stored.
  "POST /api/hosts/test": Route<None, None, HostRequest, HostTestResult>;
  // The install's generated key pair; null until one is generated.
  "GET /api/hosts/keypair": Route<None, None, None, { keypair: HostKeypair | null }>;
  // Admin. Generates the key pair; 409 when one exists unless rotate is "1",
  // which replaces it (hosts using it stop connecting until the new key is
  // installed on them).
  "POST /api/hosts/keypair": Route<None, { rotate?: "1" }, None, HostKeypair>;

  // --- checks (A10) -------------------------------------------------------
  "GET /api/checks": Route<None, None, None, CheckView[]>;
  "POST /api/checks": Route<None, None, CheckRequest, CheckView>;
  "PUT /api/checks/:id": Route<{ id: string }, None, CheckRequest, CheckView>;
  "DELETE /api/checks/:id": Route<{ id: string }, None, None, Ok>;
  "POST /api/checks/:id/run": Route<{ id: string }, None, None, CheckResult>;

  // --- metrics-k8s (A11) --------------------------------------------------
  "GET /api/metrics-k8s/nodes": Route<None, None, None, NodeSummary[]>;

  // --- backups (A12) ------------------------------------------------------
  "GET /api/backups/posture": Route<None, None, None, BackupPosture>;
  "GET /api/backups/posture.csv": Route<None, None, None, TextBody<"text/csv">>;
  // uid: the PVC's uid. at: ISO 8601 date the restore was tested.
  "POST /api/backups/volumes/:uid/restore-tests": Route<
    { uid: string },
    None,
    { at: string; note: string },
    RestoreTestMark
  >;

  // --- workloads (A13) ----------------------------------------------------
  "GET /api/workloads/links": Route<None, None, None, WorkloadLinks>;
  "GET /api/workloads/namespaces": Route<None, None, None, NamespaceView[]>;
  "GET /api/workloads/namespaces/:namespace/workloads": Route<{ namespace: string }, None, None, WorkloadView[]>;
  "GET /api/workloads/namespaces/:namespace/pods": Route<{ namespace: string }, { workload?: string }, None, PodView[]>;
  "GET /api/workloads/namespaces/:namespace/pods/:pod": Route<{ namespace: string; pod: string }, None, None, PodView>;
  "GET /api/workloads/namespaces/:namespace/events": Route<
    { namespace: string },
    { object?: string },
    None,
    EventView[]
  >;
  "GET /api/workloads/namespaces/:namespace/pods/:pod/logs": Route<
    { namespace: string; pod: string },
    { container?: string; tail?: string; previous?: "1" },
    None,
    LogLines
  >;
  // Follows the log; every event is one line, already redacted.
  "GET /api/workloads/namespaces/:namespace/pods/:pod/logs/stream": Route<
    { namespace: string; pod: string },
    { container?: string; tail?: string },
    None,
    EventStream<{ line: string }>
  >;

  // --- catalog (v0.1.x) ---------------------------------------------------
  // Every catalog app with what discovery found for it. slot filters by
  // CatalogSlot.
  "GET /api/catalog/apps": Route<None, { slot?: string; refresh?: "1" }, None, CatalogAppView[]>;
  "GET /api/catalog/apps/:id": Route<{ id: string }, None, None, CatalogAppView>;
  "GET /api/catalog/discovery": Route<None, { refresh?: "1" }, None, DiscoveryReport>;
  // The Deploy bundles, default first, with what discovery found per item.
  "GET /api/catalog/bundles": Route<None, { refresh?: "1" }, None, CatalogBundleView[]>;

  // --- deploy (v0.1.x) ----------------------------------------------------
  "GET /api/deploy/status": Route<None, None, None, DeployStatus>;
  // How the apps are reached, with the hosts and what to point at what.
  "GET /api/deploy/access": Route<None, None, None, AccessView>;
  // Admin, audited. Saves the mode and base domain; later deploys and bundle
  // runs write their Ingresses for it. Deploys nothing itself.
  "PUT /api/deploy/access": Route<None, None, AccessRequest, AccessView>;
  // Admin. Resolves defaults and validates inputs; runs nothing.
  "POST /api/deploy/plan": Route<None, None, DeployRequest, DeployPlan>;
  // Admin, audited. 409 while another job for the same release is running;
  // 400 with the plan's blockedBy when the plan is not allowed.
  "POST /api/deploy/jobs": Route<None, None, DeployJobRequest, DeployJobView>;
  // Newest first.
  "GET /api/deploy/jobs": Route<None, { appId?: string; limit?: string }, None, DeployJobView[]>;
  "GET /api/deploy/jobs/:id": Route<{ id: string }, None, None, DeployJobView>;
  // Redacted: secret input values never appear.
  "GET /api/deploy/jobs/:id/logs": Route<{ id: string }, { tail?: string }, None, LogLines>;
  "GET /api/deploy/jobs/:id/logs/stream": Route<{ id: string }, None, None, EventStream<{ line: string }>>;
  // Admin, audited. Deletes the Job; what helm already applied stays.
  "POST /api/deploy/jobs/:id/cancel": Route<{ id: string }, None, None, DeployJobView>;
  // Admin. Every step's plan, in order, with the skipped ones marked; runs nothing.
  "POST /api/deploy/bundles/plan": Route<None, None, BundleRequest, BundlePlan>;
  // Admin, audited. One step at a time, each an ordinary deploy job; stops
  // at the first failure. 409 while another bundle run is running.
  "POST /api/deploy/bundles": Route<None, None, BundleRequest, BundleRunView>;
  // Newest first.
  "GET /api/deploy/bundles": Route<None, None, None, BundleRunView[]>;
  "GET /api/deploy/bundles/:id": Route<{ id: string }, None, None, BundleRunView>;
  // Admin, audited. Cancels the running step and leaves the rest pending.
  "POST /api/deploy/bundles/:id/cancel": Route<{ id: string }, None, None, BundleRunView>;

  // --- mcp ------------------------------------------------------------------
  // The MCP streamable-HTTP endpoint, also served at MCP_PATH (/mcp).
  // Stateless: every POST is one JSON-RPC request (or batch) answered with
  // JSON; no session id, no server-sent stream. Takes an API token as a
  // bearer (401 with WWW-Authenticate without one; a session cookie is not
  // accepted here) and is rate-limited per token (429).
  "POST /api/mcp": Route<None, None, JsonRpcMessage | JsonRpcMessage[], JsonRpcMessage | JsonRpcMessage[]>;
  // 405: there is no stream to open and no session to end.
  "GET /api/mcp": Route<None, None, None, ApiError>;
  "DELETE /api/mcp": Route<None, None, None, ApiError>;

  // --- onboarding (A14) ---------------------------------------------------
  "GET /api/onboarding/state": Route<None, None, None, OnboardingState>;
  "POST /api/onboarding/steps/:step": Route<
    { step: OnboardingStepId },
    None,
    { action: "done" | "skip" },
    OnboardingState
  >;
}

export type RouteKey = keyof ApiRoutes;

// Routes served without a session, outside /api, and the module that binds
// each (ctx.publicRoute refuses any other). Each is reached by something
// that can't sign in, so each authorises the request itself.
export const PUBLIC_ROUTES = {
  "GET /join/:token": "cluster",
} as const satisfies Partial<Record<RouteKey, string>>;

export type PublicRouteKey = keyof typeof PUBLIC_ROUTES;

// What a mock of a route's response looks like: the response itself, the
// sequence of events for a stream, the text for a text body.
export type MockResponse<R> = R extends EventStream<infer T> ? T[] : R extends TextBody<string> ? string : R;

export type ApiMocks = { [K in RouteKey]: MockResponse<ApiRoutes[K]["response"]> };

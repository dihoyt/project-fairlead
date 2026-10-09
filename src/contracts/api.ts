// Every Milestone A HTTP route: method and path, path params, query, body
// and response. Mocks for every response are in ./mocks/api.ts, and the
// type of that object makes a route without a mock a compile error.
//
// Server-free on purpose: the client imports this file.

import type {
  AccountView,
  AdminOverview,
  ApiTokenChanges,
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
  OAuthConsentRequest,
  OAuthConsentView,
  PublicSignInRequest,
  PublicSignInResult,
  SessionView,
  SettingValue,
  TotpEnrollment,
  TotpStatus,
  TotpVerifyRequest,
  UserChangesRequest,
  UserView,
} from "./auth.js";
import type {
  BackupPosture,
  BackupSchedulesRequest,
  BackupSchedulesView,
  BackupTargetRequest,
  BackupTargetView,
  LonghornReplicaAdvice,
  RestoreTestMark,
  VolumeBackupSettings,
  VolumeRestorePoint,
  VolumeRestoreRequest,
} from "./backups.js";
import type { CatalogAppView, CatalogBundleView, DiscoveryReport } from "./catalog.js";
import type { CheckRequest, CheckView } from "./checks.js";
import type {
  CloudflareDiscoverRequest,
  CloudflareDiscovery,
  CloudflareHostRequest,
  CloudflareHostView,
  CloudflareTunnelDeploy,
  CloudflareTunnelRequest,
  CloudflareView,
  ConnectorKindView,
  ConnectorRemoveResult,
  ConnectorRequest,
  ConnectorTestRequest,
  ConnectorTestResult,
  ConnectorUpdate,
  ConnectorView,
  EntraGroup,
  EntraSignInRequest,
  EntraSignInView,
  StorageTargetView,
} from "./connectors.js";
import type { JoinLink, JoinLinkRequest, JoinStatus } from "./cluster.js";
import type {
  AccessRequest,
  AccessView,
  BundlePlan,
  BundleRequest,
  BundleRunView,
  DeployActionPlan,
  DeployActionRequest,
  DeployJobRequest,
  DeployJobView,
  DeployPlan,
  DeployRequest,
  DeployStatus,
  GateStatus,
  PortsView,
  UpgradeReport,
  UpgradeRequest,
  VolumeBackupView,
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
import type {
  ChannelRequest,
  ChannelView,
  EmailOAuthCallbackQuery,
  EmailOAuthStart,
  EmailSetupView,
  TestSendResult,
} from "./notify.js";
import type { OnboardingState, OnboardingStepId } from "./onboarding.js";
import type { ResetRequest, ResetResult } from "./reset.js";
import type { Draining, Healthz, JobsView, ModuleStatus } from "./system.js";
import type { TemplateDeployRequest, TemplateJobRequest, TemplatePlan, TemplatesView } from "./templates.js";
import type {
  ClusterUsageReport,
  EventView,
  LogLines,
  NamespaceView,
  PodView,
  SpaceUsageReport,
  UsageRange,
  WorkloadLinks,
  WorkloadView,
} from "./workloads.js";

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

// A non-JSON body (CSV export, a file download).
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
  // Admin. 400 for a missing or non-http(s) url, or an apiUrl the token may
  // not be sent to (see AuthentikWireRequest.apiUrl).
  "GET /api/admin/oidc/authentik": Route<None, { url: string; apiUrl?: string }, None, AuthentikWirePlan>;
  // Admin, audited (never with the token or secret). Creates or reuses the
  // provider and application, saves auth.oidc.{issuer,clientId,label,enabled}
  // (and adminGroups when given) and the client secret. 400: bad url, no
  // token given or stored, no public URL; 409: SECRETS_KEY not set; 502:
  // Authentik unreachable, refused the token, or answered unexpectedly, with
  // its status in the error.
  "POST /api/admin/oidc/authentik": Route<None, None, AuthentikWireRequest, AuthentikWireResult>;
  // Admin, audited (never with the secret). Points OIDC sign-in at Google
  // or Microsoft's multi-tenant endpoint and saves the allow and admin email
  // lists, turning on account creation at first sign-in (only allowed
  // addresses get one). 400: empty or malformed allowedEmails, no secret
  // given or reusable, no public URL, a setting locked by the environment;
  // 409: SECRETS_KEY not set.
  "POST /api/admin/oidc/public": Route<None, None, PublicSignInRequest, PublicSignInResult>;
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
  // Changes a token's name, scope or grant (OAuth grants too). 400 as POST
  // for a bad name, scope or an empty list; unknown id: 404.
  "PATCH /api/admin/tokens/:id": Route<{ id: string }, None, ApiTokenChanges, ApiTokenView>;
  "DELETE /api/admin/tokens/:id": Route<{ id: string }, None, None, Ok>;
  // The consent page of the MCP OAuth flow (see OAuthAuthorizeParams). Admin
  // with a signed-in session; approve and deny are audited. 400 with the
  // reason for an unknown client, an unregistered redirect URI or a request
  // that isn't code + PKCE S256.
  "POST /api/admin/oauth/consent": Route<None, None, OAuthConsentRequest, OAuthConsentView>;

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
  "GET /api/notify/email/setup": Route<None, None, None, EmailSetupView>;
  // Write. 400 unless the channel is an email channel with an "oauth"
  // preset, a client id and a stored client secret; 409 when
  // EmailSetupView.oauthBlocked.
  "POST /api/notify/channels/:id/oauth": Route<{ id: string }, None, None, EmailOAuthStart>;
  // A browser navigation back from Google or Microsoft, not JSON: exchanges
  // the code, seals the refresh token, records the account, audits
  // "notify.oauth", and redirects (EmailOAuthCallbackQuery).
  "GET /api/notify/oauth/callback": Route<None, EmailOAuthCallbackQuery, None, TextBody<"text/html">>;

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

  // --- longhorn (A6) ------------------------------------------------------
  // Volumes, StorageClasses and the default Setting against min(2,
  // schedulable nodes). Reads only.
  "GET /api/longhorn/replicas": Route<None, None, None, LonghornReplicaAdvice>;

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
  // Set-up (round 4). Reads are open to anyone signed in; the rest need
  // "write" and answer with the deploy job they started (DeployActionRequest
  // in ./deploy.ts), or its 400 when deploys are off or the plan is blocked.
  "GET /api/backups/target": Route<None, None, None, BackupTargetView>;
  // longhorn-target. 404 for a connectorId that is no storage target.
  "PUT /api/backups/target": Route<None, None, BackupTargetRequest, DeployJobView>;
  "GET /api/backups/schedules": Route<None, None, None, BackupSchedulesView>;
  // longhorn-recurring with schedules. 400 for a bad group name or cron.
  "PUT /api/backups/schedules": Route<None, None, BackupSchedulesRequest, DeployJobView>;
  // longhorn-recurring with this volume. 404 for a PVC that is not on Longhorn.
  "PUT /api/backups/volumes/:uid/groups": Route<{ uid: string }, None, VolumeBackupSettings, DeployJobView>;
  // longhorn-backup-now.
  "POST /api/backups/volumes/:uid/backup-now": Route<{ uid: string }, None, None, DeployJobView>;
  // The volume's backups on the target, newest first; empty when none.
  "GET /api/backups/volumes/:uid/backups": Route<{ uid: string }, None, None, VolumeRestorePoint[]>;
  // longhorn-restore's preview (POST /api/deploy/actions/plan); runs nothing.
  "POST /api/backups/restore/plan": Route<None, None, VolumeRestoreRequest, DeployActionPlan>;
  // longhorn-restore.
  "POST /api/backups/restore": Route<None, None, VolumeRestoreRequest, DeployJobView>;

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
  // range defaults to "1h"; any other value is a 400.
  "GET /api/workloads/usage": Route<None, { range?: UsageRange }, None, ClusterUsageReport>;
  "GET /api/workloads/namespaces/:namespace/usage": Route<
    { namespace: string },
    { range?: UsageRange },
    None,
    SpaceUsageReport
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
  // Every app the deploy runner installed, against the catalog's pins.
  // refresh=1 forces a new discovery.
  "GET /api/deploy/upgrades": Route<None, { refresh?: "1" }, None, UpgradeReport>;
  // Admin, audited. An upgrade run (bundleId UPGRADE_RUN): one "upgrade"
  // job at a time, stopping at the first failure. 400 for an app that is
  // not ours or not upgradable, or when nothing is available; 409 while
  // another bundle or upgrade run is running.
  "POST /api/deploy/upgrades": Route<None, None, UpgradeRequest, BundleRunView>;
  // Whether the sign-in gate can work and how each deployed app stands
  // behind it. Public and Public off are changed with the "app-gate" action.
  "GET /api/deploy/gate": Route<None, None, None, GateStatus>;
  // The forwarded port range and the Traefik entrypoints external services need.
  "GET /api/deploy/ports": Route<None, None, None, PortsView>;
  // Admin. What the action would change, from reads only; runs nothing.
  "POST /api/deploy/actions/plan": Route<None, None, DeployActionRequest, DeployActionPlan>;
  // Admin, audited. Starts the action as a deploy job (mode "action"); 400
  // with the plan's blockedBy when it is not allowed, 409 while another job
  // for the same release is running.
  "POST /api/deploy/actions/run": Route<None, None, DeployActionRequest, DeployJobView>;
  // A backup-volumes job's downloads; 404 for any other job.
  "GET /api/deploy/actions/backups/:id": Route<{ id: string }, None, None, VolumeBackupView>;
  // Admin, audited. One volume as tar.gz, streamed from the backup pod as it
  // is read (no Content-Length); 409 unless the backup is ready.
  "GET /api/deploy/actions/backups/:id/files/:claim": Route<
    { id: string; claim: string },
    None,
    None,
    TextBody<"application/gzip">
  >;
  // Admin. Stops the backup pod; already stopped is not an error.
  "POST /api/deploy/actions/backups/:id/done": Route<{ id: string }, None, None, VolumeBackupView>;

  // --- templates ------------------------------------------------------------
  // The library and every saved instance with its latest job.
  "GET /api/templates": Route<None, None, None, TemplatesView>;
  // Admin. Renders and checks the template and asks the deploy runner for
  // its plan; runs nothing. 404 for an unknown template; field errors and
  // guardrail findings come back in the plan, not as a 400.
  "POST /api/templates/plan": Route<None, None, TemplateDeployRequest, TemplatePlan>;
  // Admin, audited. Starts a deploy job for the instance (job views, logs
  // and cancel are under /api/deploy/jobs); an install saves the instance,
  // replacing one of the same name and template. 400 with the plan's
  // blockedBy when the plan is not allowed; 409 for a name another template
  // uses, or while the instance has a job running.
  "POST /api/templates/jobs": Route<None, None, TemplateJobRequest, DeployJobView>;

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

  // --- connectors (B1) ----------------------------------------------------
  // Reads are open to anyone signed in; everything else needs "admin".
  "GET /api/connectors/kinds": Route<None, None, None, ConnectorKindView[]>;
  "GET /api/connectors": Route<None, None, None, ConnectorView[]>;
  // Verifies, then saves whatever the checks say; the view carries them.
  // 409 for a second instance of a single kind.
  "POST /api/connectors": Route<None, None, ConnectorRequest, ConnectorView>;
  "POST /api/connectors/test": Route<None, None, ConnectorTestRequest, ConnectorTestResult>;
  "GET /api/connectors/:id": Route<{ id: string }, None, None, ConnectorView>;
  "PUT /api/connectors/:id": Route<{ id: string }, None, ConnectorUpdate, ConnectorView>;
  // cleanup=1 first deletes what the instance created in the tool.
  "DELETE /api/connectors/:id": Route<{ id: string }, { cleanup?: "1" }, None, ConnectorRemoveResult>;
  // Re-runs verify (or health) and returns the updated view.
  "POST /api/connectors/:id/test": Route<{ id: string }, None, None, ConnectorView>;
  // 400 for a kind without reconcile.
  "POST /api/connectors/:id/reconcile": Route<{ id: string }, None, None, ConnectorView>;

  // --- connector-cloudflare (B2) -----------------------------------------
  "GET /api/connector-cloudflare/view": Route<None, None, None, CloudflareView>;
  // Reconciles now; 409 without a connector.
  "POST /api/connector-cloudflare/sync": Route<None, None, None, CloudflareView>;
  // 404 for a host the Access step doesn't list.
  "PUT /api/connector-cloudflare/hosts/:host": Route<{ host: string }, None, CloudflareHostRequest, CloudflareHostView>;
  "POST /api/connector-cloudflare/discover": Route<None, None, CloudflareDiscoverRequest, CloudflareDiscovery>;
  "POST /api/connector-cloudflare/tunnel": Route<None, None, CloudflareTunnelRequest, CloudflareView>;
  // 409 without a connector or a tunnel; the deploy's own 400 when deploys are off.
  "POST /api/connector-cloudflare/tunnel/deploy": Route<None, None, None, CloudflareTunnelDeploy>;

  // --- connector-entra (B3) ------------------------------------------------
  "GET /api/connector-entra/view": Route<None, None, None, EntraSignInView>;
  // Creates the sign-in app registration (or reuses the one this install
  // owns), makes a client secret and sets OIDC sign-in to it. Admin. 409
  // without a connector; 400 when the public URL is unset or http (other
  // than localhost), or when sign-in settings are locked by the environment;
  // 502 when Graph refuses.
  "POST /api/connector-entra/signin": Route<None, None, EntraSignInRequest, EntraSignInView>;
  // Security groups in the tenant, by display name prefix; at most 50. 409
  // without a connector; 502 when Graph refuses (it needs Group.Read.All).
  "GET /api/connector-entra/groups": Route<None, { search?: string }, None, EntraGroup[]>;

  // --- connector-storage (round 4) -----------------------------------------
  // The storage-target connectors as StorageTargetService sees them. Create,
  // edit, test and remove go through /api/connectors (kind "storage-target").
  "GET /api/connector-storage/targets": Route<None, None, None, StorageTargetView[]>;
  "GET /api/connector-storage/targets/:id": Route<{ id: string }, None, None, StorageTargetView>;

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

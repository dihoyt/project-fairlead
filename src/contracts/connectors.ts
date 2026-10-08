// Connectors (Milestone B): this product managing an outside tool through
// its API with credentials an admin gives it. Module "connectors" owns the
// registry, the stored instances and their sealed credentials; each tool is
// a connector kind that another module ("connector-cloudflare",
// "connector-entra") adds with ctx.services.get("connectors").addKind(...).
// Those modules load after "connectors" (src/modules/index.ts), so adding a
// kind at register time is safe.
//
// Server-free on purpose: the client imports this file.

import type { CheckResult, Status } from "./health.js";
import type { DeployJobView } from "./deploy.js";
import type { DriftReport, DriftState, OwnedObject } from "./ownership.js";

export type ConnectorCapability =
  // Creates and removes DNS records.
  | "dns"
  // Runs a tunnel and routes hostnames over it.
  | "tunnel"
  // Puts a sign-in in front of a hostname.
  | "access"
  // Creates sign-in app registrations and lists groups.
  | "identity";

export interface ConnectorField {
  // Key in ConnectorRequest.values.
  key: string;
  label: string;
  help?: string;
  placeholder?: string;
  // "secret": write-only. Sealed with SECRETS_KEY, never returned or logged,
  // reported as ConnectorView.secrets[key].
  type: "text" | "secret" | "url";
  required: boolean;
}

export interface ConnectorKindView {
  kind: string;
  label: string;
  // One or two sentences: what it manages and what the credential needs.
  description: string;
  capabilities: ConnectorCapability[];
  fields: ConnectorField[];
  // At most one instance per install.
  single: boolean;
  // Where to create the credential in the tool's own UI.
  docsUrl?: string;
}

export interface ConnectorView {
  id: string;
  kind: string;
  name: string;
  // The non-secret fields' values.
  config: Record<string, string>;
  // Secret field key -> a value is stored.
  secrets: Record<string, boolean>;
  // Worst of checks; "unknown" until the first check has run.
  status: Status;
  // The latest verify or health run, every check with a detail.
  checks: CheckResult[];
  checkedAt?: string;
  // The latest reconcile, for kinds that keep objects in the tool.
  drift?: DriftReport;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export interface ConnectorRequest {
  kind: string;
  name: string;
  // By ConnectorField.key. Unknown keys are a 400; so is a missing required one.
  values: Record<string, string>;
}

// PUT: a secret field left out (or "") keeps the stored value; the kind
// cannot change.
export interface ConnectorUpdate {
  name?: string;
  values?: Record<string, string>;
}

// Tests values without saving them. With `id`, secret fields left out are
// taken from that stored instance, so an edit form can test without the
// admin re-entering the token.
export interface ConnectorTestRequest {
  kind: string;
  values: Record<string, string>;
  id?: string;
}

export interface ConnectorTestResult {
  // No check is "crit" or "unknown".
  ok: boolean;
  checks: CheckResult[];
}

export interface ConnectorRemoveResult {
  ok: true;
  // With cleanup=1: objects the connector had created in the tool and removed.
  removed: number;
  // Objects it could not remove, one sentence each; the instance is removed anyway.
  errors: string[];
}

// --- Server side: what a connector module implements ------------------------

// A stored instance with its secrets unsealed. Server only; never sent to a
// client or written to a log.
export interface ConnectorInstance {
  id: string;
  kind: string;
  name: string;
  config: Record<string, string>;
  secrets: Record<string, string>;
}

// Field values, secrets included, as typed into a form or stored.
export type ConnectorValues = Record<string, string>;

export interface OwnedRecord extends OwnedObject {
  updatedAt: string;
}

// What an instance created in its tool, kept by the framework per instance
// in the database. A connector records an object right after creating it and
// changes or deletes only objects recorded here: anything else in the tool
// with the same name is "conflict-unowned" and left alone.
export interface OwnedStore {
  list(kind?: string): OwnedRecord[];
  get(key: string, kind: string): OwnedRecord | undefined;
  // Insert or replace by (key, kind).
  put(obj: OwnedObject): void;
  delete(key: string, kind: string): void;
}

export interface ConnectorKind {
  kind: string;
  label: string;
  description: string;
  capabilities: ConnectorCapability[];
  fields: ConnectorField[];
  single?: boolean;
  docsUrl?: string;
  // Checks a credential and settings before they are saved, and again on
  // demand. Never throws: a failure is a "crit" check saying why, with `raw`.
  verify(values: ConnectorValues, signal: AbortSignal): Promise<CheckResult[]>;
  // Scheduled health of a saved instance. Defaults to verify(). Never throws.
  health?(instance: ConnectorInstance, signal: AbortSignal): Promise<CheckResult[]>;
  // Brings the tool in line with what this install wants (scheduled, and on
  // demand) and reports what differs. May throw; the framework records the
  // error as the instance's drift check.
  reconcile?(instance: ConnectorInstance, owned: OwnedStore, signal: AbortSignal): Promise<DriftReport>;
  // Deletes what owned lists from the tool, for DELETE ...?cleanup=1. Returns
  // the count removed and one sentence per failure; never throws.
  cleanup?(instance: ConnectorInstance, owned: OwnedStore): Promise<{ removed: number; errors: string[] }>;
}

// Provided by module "connectors" as ctx.services.get("connectors").
export interface ConnectorRegistry {
  // A second kind with the same name throws.
  addKind(kind: ConnectorKind): void;
  instances(kind: string): Promise<ConnectorInstance[]>;
  instance(id: string): Promise<ConnectorInstance | undefined>;
  owned(instanceId: string): OwnedStore;
  // Runs the kind's reconcile now (one at a time per instance), stores the
  // report on the instance and returns it. Undefined for an unknown instance
  // or a kind without reconcile.
  reconcile(instanceId: string): Promise<DriftReport | undefined>;
}

// --- Cloudflare (module "connector-cloudflare") -----------------------------
//
// One instance per install, kind "cloudflare". Its token needs Account >
// Cloudflare Tunnel > Edit and Zone > DNS > Edit, plus Account > Access: Apps
// and Policies > Edit when Access apps are on. For each app hostname the
// Access step knows (AccessView.hosts) it keeps:
// - tunnel exposure (default): a route on the tunnel to the ingress service
//   and a proxied CNAME to <tunnel id>.cfargotunnel.com;
// - direct exposure: a DNS-only A record to the install's public address;
//   TLS comes from cert-manager on the app's Ingress;
// - a Cloudflare Access app, when the access-apps setting says so.
// Objects it creates carry the product's owner marker (DNS comment, Access
// app name prefix) and are recorded in OwnedStore; same-named objects
// without it are reported, never touched.

export type CloudflareExposure = "tunnel" | "direct";

// The connector-cloudflare.accessApps setting. "never" is the default.
export type CloudflareAccessPolicy = "never" | "always" | "per-app";

export interface CloudflareObjectState {
  // "pending": wanted, not created yet (the next sync creates it).
  state: DriftState | "pending";
  externalId?: string;
  // "CNAME grafana.example.com -> 6f1c….cfargotunnel.com (proxied)".
  detail: string;
}

export interface CloudflareHostView {
  host: string;
  appId?: string;
  exposure: CloudflareExposure;
  // The Access app is wanted: the setting, or the per-app choice under "per-app".
  access: boolean;
  dns: CloudflareObjectState;
  // tunnel exposure only.
  route?: CloudflareObjectState;
  // When access is wanted, or one we created is still there.
  accessApp?: CloudflareObjectState;
  status: Status;
  // One sentence: "Routed over the tunnel" or what is wrong.
  detail: string;
}

export interface CloudflareTunnelView {
  id: string;
  name: string;
  // Cloudflare's own: "healthy", "degraded", "down", "inactive".
  status: string;
  // false: this install created it.
  adopted: boolean;
}

export interface CloudflareView {
  // Unset when no Cloudflare connector is saved; everything else is then empty.
  connectorId?: string;
  accountId?: string;
  zone?: string;
  tunnel?: CloudflareTunnelView;
  // The origin tunnel routes point at (AccessView.ingressService).
  ingressService?: string;
  // The A record target for direct exposure.
  publicAddress?: string;
  accessPolicy: CloudflareAccessPolicy;
  hosts: CloudflareHostView[];
  syncedAt?: string;
  // The last sync failed before reaching the hosts: why, one sentence.
  error?: string;
  // Things the connector doesn't own that break its hosts (a wildcard
  // record pointing at another tunnel), one sentence each.
  warnings?: string[];
}

// Per-app choices, keyed by hostname. `access` is honoured under "per-app" only.
export interface CloudflareHostRequest {
  exposure?: CloudflareExposure;
  access?: boolean;
}

// What a token can see, for the setup form. The token is used for this
// call only and never stored or echoed.
export interface CloudflareDiscoverRequest {
  token: string;
}

export interface CloudflareDiscovery {
  // From /user/tokens/verify: "active", "disabled", "expired".
  tokenStatus: string;
  accounts: Array<{ id: string; name: string }>;
  zones: Array<{ id: string; name: string; accountId: string }>;
  tunnels: Array<{ id: string; name: string; status: string; accountId: string }>;
}

// Adopt an existing tunnel by id, or create a remotely managed one (named
// after the product when `name` is left out). Saved on the instance.
export interface CloudflareTunnelRequest {
  tunnelId?: string;
  name?: string;
}

// Deploys the cloudflared app with the instance's tunnel token. The token
// goes from Cloudflare into the deploy job's values Secret on the server and
// never reaches the browser.
export type CloudflareTunnelDeploy = DeployJobView;

// --- Microsoft Entra ID (module "connector-entra") --------------------------
//
// One instance per install, kind "entra": a tenant id plus the client id and
// secret of a management app registration holding Microsoft Graph's
// Application.ReadWrite.OwnedBy application permission (admin consented). It
// creates the app registration this install signs in through, owned by that
// management app, with the console's redirect URI and the groups claim, and
// hands its client id and a client secret to sign-in (services "signin").
// Reconcile puts a changed redirect URI back and rotates the client secret
// before it expires. Entra refuses http redirect URIs other than localhost.
// Entra's groups claim carries group object ids, so auth.oidc.adminGroups
// holds ids; GET /api/connector-entra/groups is how an admin picks them.

export interface EntraSignInAppView {
  // The application (client) id.
  appId: string;
  objectId: string;
  displayName: string;
  redirectUris: string[];
  // Expiry of the newest client secret this install created.
  secretExpiresAt?: string;
  // "pending": not created yet.
  state: DriftState | "pending";
}

export interface EntraSignInView {
  // Unset when no Entra connector is saved; everything else is then empty.
  connectorId?: string;
  tenantId?: string;
  // What the app registration should carry: <public URL>/auth/oidc/callback.
  // "" until a public URL is set.
  redirectUri: string;
  app?: EntraSignInAppView;
  // Sign-in currently uses this app (auth.oidc.clientId is app.appId).
  wired: boolean;
  // Where a tenant admin grants the management app its consent.
  consentUrl?: string;
  // One sentence when sign-in cannot be set up as things stand: an http
  // public URL, no public URL, a missing permission.
  warning?: string;
}

export interface EntraSignInRequest {
  // Group object ids whose members are admins (auth.oidc.adminGroups).
  adminGroups?: string[];
  // The sign-in button's text; "Sign in with Microsoft" when left out.
  label?: string;
}

export interface EntraGroup {
  id: string;
  displayName: string;
}

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
import type { AppGateState, DeployJobView } from "./deploy.js";
import type { DriftReport, DriftState, OwnedObject } from "./ownership.js";

export type ConnectorCapability =
  // Creates and removes DNS records.
  | "dns"
  // Runs a tunnel and routes hostnames over it.
  | "tunnel"
  // Puts a sign-in in front of a hostname.
  | "access"
  // Creates sign-in app registrations and lists groups.
  | "identity"
  // A place backups are written to (NFS export, S3 bucket, SMB share).
  | "backup-target";

export interface ConnectorField {
  // Key in ConnectorRequest.values.
  key: string;
  label: string;
  help?: string;
  placeholder?: string;
  // "secret": write-only. Sealed with SECRETS_KEY, never returned or logged,
  // reported as ConnectorView.secrets[key]. "select": one of `options`.
  type: "text" | "secret" | "url" | "select";
  required: boolean;
  // "select" only.
  options?: Array<{ value: string; label: string }>;
  // Shown (and sent) only while another field holds one of these values,
  // e.g. S3 keys only when protocol is "s3". A hidden field is sent as "".
  showWhen?: { key: string; values: string[] };
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

// --- Storage targets (module "connector-storage") ---------------------------
//
// Kind "storage-target", any number of instances: a place backups go. Fields
// (ConnectorField.key):
//   protocol         "nfs" | "s3" | "smb" (select)
//   url              nfs://server:/export, s3://bucket@region/, cifs://server/share
//                    (Longhorn's backup target URL forms)
//   path             optional prefix under the export, bucket or share: "cluster-a"
//   endpoint         S3/MinIO only: "https://minio.example.com:9000"; empty for AWS
//   accessKeyId      S3 only
//   secretAccessKey  S3 only (secret)
//   username         SMB only
//   password         SMB only (secret)
// Protocol-specific fields are required: false in the field list (they show
// by showWhen) and the kind's verify refuses a protocol missing its own.
// verify and health check reachability from the console pod: TCP to 2049
// (nfs), 445 (smb) or the S3 endpoint, and for S3 a signed ListObjectsV2 on
// the bucket proving the keys. A mount is proved only by Longhorn, once the
// target is applied (BackupTarget.status.available), reported in usedBy.

export const STORAGE_TARGET_KIND = "storage-target";

export type StorageProtocol = "nfs" | "s3" | "smb";

export interface StorageTargetUse {
  // longhorn: Longhorn's default BackupTarget points at this target.
  // postgres: the shared Postgres cluster archives to it (round 4, C6).
  kind: "longhorn" | "postgres";
  // "Longhorn backup target", "Postgres WAL archive".
  label: string;
  // Longhorn: BackupTarget.status.available; absent until it reports.
  available?: boolean;
  // Longhorn's condition message when unavailable, verbatim.
  message?: string;
  // Longhorn: BackupTarget.status.lastSyncedAt.
  lastSyncAt?: string;
}

export interface StorageTargetView {
  // The connector instance id.
  id: string;
  name: string;
  protocol: StorageProtocol;
  // The full target URL with `path` applied and no credentials: what
  // Longhorn's BackupTarget gets. "s3://backups@us-east-1/cluster-a/".
  url: string;
  // S3/MinIO only.
  endpoint?: string;
  // The server or host part of url: "nas.example.com", for matching Hosts.
  server?: string;
  // s3: secretAccessKey stored; smb: password stored; nfs: always false.
  hasCredentials: boolean;
  // Worst of checks; "unknown" until the first check ran.
  status: Status;
  // Reachability per protocol, each with a detail (ConnectorView.checks).
  checks: CheckResult[];
  checkedAt?: string;
  // What points at it now; empty when nothing does.
  usedBy: StorageTargetUse[];
}

// The Secret a consumer reads the target's credentials from, in the keys
// Longhorn expects (S3: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and, with an
// endpoint, AWS_ENDPOINTS; SMB: CIFS_USERNAME, CIFS_PASSWORD). CNPG's
// barmanObjectStore takes the same Secret by key reference. Server only: it
// carries the values, so it goes into a deploy job's values, never to a
// route or a log.
export interface StorageCredentialsSecret {
  apiVersion: "v1";
  kind: "Secret";
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  type: "Opaque";
  stringData: Record<string, string>;
}

// Provided by module "connector-storage" as ctx.services.get("storage-targets").
export interface StorageTargetService {
  // Every storage-target instance, by name.
  list(): Promise<StorageTargetView[]>;
  get(id: string): Promise<StorageTargetView | undefined>;
  // The credential Secret for target `id` in `namespace`, named
  // "<ownerMarker.externalPrefix>backup-<id>" and labelled managed-by.
  // Undefined for nfs, which takes none. Rejects for an unknown id, or a
  // target whose credential is not stored.
  credentialsSecret(id: string, namespace: string): Promise<StorageCredentialsSecret | undefined>;
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
  // The Access app is wanted: the setting, or the per-app choice under
  // "per-app", which defaults to on for an app with no sign-in of its own.
  access: boolean;
  // The app has no sign-in of its own (CatalogEntry.noLogin).
  noLogin?: boolean;
  dns: CloudflareObjectState;
  // tunnel exposure only.
  route?: CloudflareObjectState;
  // When access is wanted, or one we created is still there.
  accessApp?: CloudflareObjectState;
  // How the console's sign-in gate treats the app (AppGateView.state);
  // absent when the gate doesn't know the host.
  gate?: AppGateState;
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
  // While no tunnel is picked: the account's tunnels, to adopt one instead
  // of creating another (a reinstall finds its old tunnel here, by name).
  existingTunnels?: Array<{ id: string; name: string; status: string }>;
  // The origin tunnel routes point at (AccessView.ingressService).
  ingressService?: string;
  // The A (or AAAA) record target for direct exposure.
  publicAddress?: string;
  // "set": the connector's Public address field; "detected": the field is
  // empty and the address was looked up from this cluster at the last sync.
  publicAddressSource?: "set" | "detected";
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

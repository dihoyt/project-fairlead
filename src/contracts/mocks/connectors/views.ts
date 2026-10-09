// Pure data, so the client can import it.
import type {
  CloudflareDiscovery,
  CloudflareHostView,
  CloudflareView,
  ConnectorKindView,
  ConnectorView,
  EntraGroup,
  EntraSignInView,
  StorageTargetView,
} from "../../connectors.js";
import { STORAGE_TARGET_KIND } from "../../connectors.js";
import type { CheckResult } from "../../health.js";
import { HOUR, isoAgo } from "../time.js";

export const mockCloudflareKind: ConnectorKindView = {
  kind: "cloudflare",
  label: "Cloudflare",
  description:
    "Creates the DNS records, tunnel routes and optional Access apps for every app hostname. " +
    "Needs an API token with Cloudflare Tunnel Edit and DNS Edit (and Access: Apps and Policies Edit for Access apps).",
  capabilities: ["dns", "tunnel", "access"],
  fields: [
    { key: "apiToken", label: "API token", type: "secret", required: true },
    { key: "accountId", label: "Account ID", type: "text", required: true },
    { key: "zone", label: "Zone", type: "text", required: true, placeholder: "example.com" },
    { key: "tunnelId", label: "Tunnel ID", type: "text", required: false, help: "Left empty: one is created." },
    {
      key: "publicAddress",
      label: "Public address",
      type: "text",
      required: false,
      help: "Where DNS-only records for direct apps point: your router's public IP.",
    },
    {
      key: "accessEmails",
      label: "Access allow list",
      type: "text",
      required: false,
      help: "Emails or @domains Cloudflare Access lets in, comma separated.",
      placeholder: "you@example.com, @example.com",
    },
  ],
  single: true,
  docsUrl: "https://dash.cloudflare.com/profile/api-tokens",
};

export const mockFakeKind: ConnectorKindView = {
  kind: "fake",
  label: "Fake tool",
  description: "A connector that talks to nothing, for tests.",
  capabilities: ["dns"],
  fields: [
    { key: "token", label: "Token", type: "secret", required: true },
    { key: "zone", label: "Zone", type: "text", required: true },
  ],
  single: false,
};

export const mockConnectorKinds: ConnectorKindView[] = [mockCloudflareKind];

export const mockCloudflareConnector: ConnectorView = {
  id: "cn_1",
  kind: "cloudflare",
  name: "Cloudflare",
  config: {
    accountId: "0123456789abcdef0123456789abcdef",
    zone: "example.test",
    tunnelId: "",
    publicAddress: "",
    accessEmails: "",
  },
  secrets: { apiToken: true },
  status: "ok",
  checks: [
    {
      id: "token",
      label: "API token",
      status: "ok",
      detail: "Token is active",
      observedAt: isoAgo(60_000),
    },
    {
      id: "zone",
      label: "Zone",
      status: "ok",
      detail: "example.test is on this account; DNS records can be edited",
      observedAt: isoAgo(60_000),
    },
    {
      id: "tunnel",
      label: "Tunnel",
      status: "ok",
      detail: "Tunnel scope granted; no tunnel chosen yet, one will be created",
      observedAt: isoAgo(60_000),
    },
  ],
  checkedAt: isoAgo(60_000),
  drift: {
    checkedAt: isoAgo(60_000),
    items: [
      { key: "grafana.example.test", kind: "cf-dns-record", externalId: "rec_1", state: "in-sync" },
      { key: "grafana.example.test", kind: "cf-tunnel-route", state: "in-sync" },
      {
        key: "longhorn.example.test",
        kind: "cf-dns-record",
        state: "conflict-unowned",
        diff: [{ path: "content", want: "6f1c.cfargotunnel.com", have: "10.0.0.20" }],
      },
    ],
  },
  createdAt: isoAgo(2 * HOUR),
  createdBy: "admin",
  updatedAt: isoAgo(2 * HOUR),
};

export const mockConnectors: ConnectorView[] = [mockCloudflareConnector];

const tunnelId = "6f1c2d3e-0000-4000-8000-000000000001";

export const mockCloudflareHosts: CloudflareHostView[] = [
  {
    host: "grafana.example.test",
    appId: "grafana",
    exposure: "tunnel",
    access: false,
    dns: {
      state: "in-sync",
      externalId: "rec_1",
      detail: `CNAME grafana.example.test -> ${tunnelId}.cfargotunnel.com (proxied)`,
    },
    route: { state: "in-sync", detail: "grafana.example.test -> http://traefik.kube-system.svc.cluster.local:80" },
    status: "ok",
    detail: "Routed over the tunnel",
  },
  {
    host: "longhorn.example.test",
    appId: "longhorn",
    exposure: "tunnel",
    access: false,
    dns: {
      state: "conflict-unowned",
      detail: "An A record for longhorn.example.test exists without this install's marker; left alone",
    },
    route: { state: "in-sync", detail: "longhorn.example.test -> http://traefik.kube-system.svc.cluster.local:80" },
    status: "crit",
    detail: "A DNS record this install didn't create is in the way; delete it in Cloudflare to let the route through",
  },
];

export const mockCloudflareView: CloudflareView = {
  connectorId: "cn_1",
  accountId: "0123456789abcdef0123456789abcdef",
  zone: "example.test",
  tunnel: { id: tunnelId, name: "console", status: "healthy", adopted: false },
  ingressService: "http://traefik.kube-system.svc.cluster.local:80",
  accessPolicy: "never",
  hosts: mockCloudflareHosts,
  syncedAt: isoAgo(60_000),
};

export const mockCloudflareEmpty: CloudflareView = { accessPolicy: "never", hosts: [] };

// Connected, no tunnel picked yet, and one left in the account by an earlier install.
const { tunnel: _tunnel, ...untunnelled } = mockCloudflareView;
export const mockCloudflareNoTunnel: CloudflareView = {
  ...untunnelled,
  existingTunnels: [{ id: tunnelId, name: "console", status: "down" }],
  hosts: [],
};

export const mockCloudflareDiscovery: CloudflareDiscovery = {
  tokenStatus: "active",
  accounts: [{ id: "0123456789abcdef0123456789abcdef", name: "Example account" }],
  zones: [{ id: "zone_1", name: "example.test", accountId: "0123456789abcdef0123456789abcdef" }],
  tunnels: [{ id: tunnelId, name: "console", status: "healthy", accountId: "0123456789abcdef0123456789abcdef" }],
};

// --- Entra ------------------------------------------------------------------

export const mockEntraKind: ConnectorKindView = {
  kind: "entra",
  label: "Microsoft Entra ID",
  description:
    "Creates and rotates the app registration this install signs in through. " +
    "Needs an app registration with Microsoft Graph's Application.ReadWrite.OwnedBy application permission " +
    "(and Group.Read.All to pick admin groups), admin consented.",
  capabilities: ["identity"],
  fields: [
    { key: "tenantId", label: "Tenant ID", type: "text", required: true },
    { key: "clientId", label: "Client ID", type: "text", required: true },
    { key: "clientSecret", label: "Client secret", type: "secret", required: true },
  ],
  single: true,
  docsUrl: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
};

const entraTenant = "00000000-0000-4000-8000-00000000e117";

export const mockEntraSignIn: EntraSignInView = {
  connectorId: "cn_2",
  tenantId: entraTenant,
  redirectUri: "https://console.example.test/auth/oidc/callback",
  app: {
    appId: "11111111-0000-4000-8000-00000000a991",
    objectId: "22222222-0000-4000-8000-00000000a991",
    displayName: "Console sign-in",
    redirectUris: ["https://console.example.test/auth/oidc/callback"],
    credential: "secret",
    secretExpiresAt: isoAgo(-150 * 24 * HOUR),
    state: "in-sync",
  },
  wired: true,
  consentUrl: `https://login.microsoftonline.com/${entraTenant}/adminconsent?client_id=33333333-0000-4000-8000-0000000000c1`,
};

export const mockEntraSignInNone: EntraSignInView = {
  redirectUri: "https://console.example.test/auth/oidc/callback",
  wired: false,
};

export const mockEntraGroups: EntraGroup[] = [
  { id: "44444444-0000-4000-8000-0000000000a1", displayName: "Cluster admins" },
  { id: "44444444-0000-4000-8000-0000000000a2", displayName: "Cluster operators" },
];

// Both credentials are certificates the console rolls itself.
export const mockEntraSignInCertificate: EntraSignInView = {
  ...mockEntraSignIn,
  app: {
    ...mockEntraSignIn.app!,
    credential: "certificate",
    certificateExpiresAt: isoAgo(-300 * 24 * HOUR),
  },
  management: {
    credential: "certificate",
    certificateExpiresAt: isoAgo(-200 * 24 * HOUR),
    secretStored: false,
  },
};
delete mockEntraSignInCertificate.app!.secretExpiresAt;

// The management app still signs in with its pasted secret: the console
// could not upload its certificate, so the admin has one step left.
export const mockEntraManagementPending: EntraSignInView = {
  ...mockEntraSignInCertificate,
  management: {
    credential: "secret",
    secretStored: true,
    step: "Upload the console's certificate to the management app under Certificates & secrets, then delete its client secret.",
  },
};

export const mockEntraCertificate = `-----BEGIN CERTIFICATE-----
MIIBszCCAVmgAwIBAgIUQ2VydGlmaWNhdGVNb2NrT25seTAKBggqhkjOPQQDAjAa
-----END CERTIFICATE-----
`;
// --- Storage targets ----------------------------------------------------------

export const mockStorageTargetKind: ConnectorKindView = {
  kind: STORAGE_TARGET_KIND,
  label: "Storage target",
  description:
    "A place backups go: an NFS export, an S3 or MinIO bucket, or an SMB/CIFS share. " +
    "S3 needs an access key that can list, read and write the bucket; SMB a user that can write the share.",
  capabilities: ["backup-target"],
  fields: [
    {
      key: "protocol",
      label: "Protocol",
      type: "select",
      required: true,
      options: [
        { value: "nfs", label: "NFS export" },
        { value: "s3", label: "S3 or MinIO bucket" },
        { value: "smb", label: "SMB/CIFS share" },
      ],
    },
    {
      key: "url",
      label: "Target URL",
      type: "text",
      required: true,
      help: "nfs://server:/export, s3://bucket@region/ or cifs://server/share",
      placeholder: "nfs://nas.example.com:/backups",
    },
    { key: "path", label: "Path prefix", type: "text", required: false, help: "A folder under it, for this cluster." },
    {
      key: "endpoint",
      label: "S3 endpoint",
      type: "url",
      required: false,
      help: "MinIO or another S3-compatible server; empty for AWS.",
      placeholder: "https://minio.example.com:9000",
      showWhen: { key: "protocol", values: ["s3"] },
    },
    {
      key: "accessKeyId",
      label: "Access key ID",
      type: "text",
      required: false,
      showWhen: { key: "protocol", values: ["s3"] },
    },
    {
      key: "secretAccessKey",
      label: "Secret access key",
      type: "secret",
      required: false,
      showWhen: { key: "protocol", values: ["s3"] },
    },
    {
      key: "username",
      label: "Username",
      type: "text",
      required: false,
      showWhen: { key: "protocol", values: ["smb"] },
    },
    {
      key: "password",
      label: "Password",
      type: "secret",
      required: false,
      showWhen: { key: "protocol", values: ["smb"] },
    },
  ],
  single: false,
};

const reach = (id: string, label: string, status: CheckResult["status"], detail: string, raw?: unknown) => ({
  id,
  label,
  status,
  detail,
  observedAt: isoAgo(60_000),
  ...(raw === undefined ? {} : { raw }),
});

// NFS, reachable, Longhorn's target and available.
export const mockNfsTarget: StorageTargetView = {
  id: "cn_st1",
  name: "NAS backups",
  protocol: "nfs",
  url: "nfs://nas.example.test:/volume1/backups/cluster/",
  server: "nas.example.test",
  hasCredentials: false,
  status: "ok",
  checks: [reach("tcp", "NFS port", "ok", "nas.example.test:2049 accepts connections (4 ms)")],
  checkedAt: isoAgo(60_000),
  usedBy: [{ kind: "longhorn", label: "Longhorn backup target", available: true, lastSyncAt: isoAgo(5 * 60_000) }],
};

// MinIO, keys proved by a signed ListObjectsV2, not used yet.
export const mockS3Target: StorageTargetView = {
  id: "cn_st2",
  name: "MinIO",
  protocol: "s3",
  url: "s3://cluster-backups@us-east-1/",
  endpoint: "https://minio.example.test:9000",
  server: "minio.example.test",
  hasCredentials: true,
  status: "ok",
  checks: [
    reach("tcp", "Endpoint", "ok", "minio.example.test:9000 accepts connections (6 ms)"),
    reach("list", "Bucket access", "ok", "Listed cluster-backups with the access key (0 objects)"),
  ],
  checkedAt: isoAgo(60_000),
  usedBy: [],
};

// SMB, the server refuses port 445.
export const mockSmbTarget: StorageTargetView = {
  id: "cn_st3",
  name: "Office share",
  protocol: "smb",
  url: "cifs://fileserver.example.test/backups/",
  server: "fileserver.example.test",
  hasCredentials: true,
  status: "crit",
  checks: [
    reach("tcp", "SMB port", "crit", "fileserver.example.test:445 refused the connection", {
      error: "connect ECONNREFUSED 10.0.0.30:445",
    }),
  ],
  checkedAt: isoAgo(60_000),
  usedBy: [],
};

export const mockStorageTargets: StorageTargetView[] = [mockNfsTarget, mockS3Target, mockSmbTarget];

// The S3 target as GET /api/connectors shows it.
export const mockStorageConnector: ConnectorView = {
  id: mockS3Target.id,
  kind: STORAGE_TARGET_KIND,
  name: mockS3Target.name,
  config: {
    protocol: "s3",
    url: "s3://cluster-backups@us-east-1/",
    path: "",
    endpoint: "https://minio.example.test:9000",
    accessKeyId: "AKIAMOCKMOCKMOCK0001",
    username: "",
  },
  secrets: { secretAccessKey: true, password: false },
  status: mockS3Target.status,
  checks: mockS3Target.checks,
  checkedAt: mockS3Target.checkedAt,
  createdAt: isoAgo(2 * HOUR),
  createdBy: "admin",
  updatedAt: isoAgo(2 * HOUR),
};

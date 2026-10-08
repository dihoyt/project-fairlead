// Pure data, so the client can import it.
import type {
  CloudflareDiscovery,
  CloudflareHostView,
  CloudflareView,
  ConnectorKindView,
  ConnectorView,
} from "../../connectors.js";
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

export const mockCloudflareDiscovery: CloudflareDiscovery = {
  tokenStatus: "active",
  accounts: [{ id: "0123456789abcdef0123456789abcdef", name: "Example account" }],
  zones: [{ id: "zone_1", name: "example.test", accountId: "0123456789abcdef0123456789abcdef" }],
  tunnels: [{ id: tunnelId, name: "console", status: "healthy", accountId: "0123456789abcdef0123456789abcdef" }],
};

// Catalog, discovery and deploy mocks. Pure data, so the client can import
// it. Versions here are placeholders for building against, not the pins the
// catalog module ships.
import type {
  BundleItemView,
  CatalogAppView,
  CatalogBundle,
  CatalogBundleView,
  CatalogEntry,
  CatalogService,
  DetectedApp,
  DiscoveryReport,
  IngressHost,
} from "../catalog.js";
import {
  UPGRADE_RUN,
  type AccessView,
  type BundlePlan,
  type BundleRunView,
  type DeployActionPlan,
  type DeployJobView,
  type DeployPlan,
  type DeployStatus,
  type UpgradeReport,
} from "../deploy.js";
import type { HostKeypair } from "../hosts.js";
import { checkDisk } from "../disk.js";
import { HOUR, MOCK_NOW, isoAgo } from "./time.js";

const host = (
  help = "The address it will answer on. Point DNS for it at your ingress."
): CatalogEntry["inputs"][0] => ({
  key: "host",
  label: "Hostname",
  help,
  kind: "hostname",
  required: true,
});

const helm = (repo: string, chart: string, version: string): CatalogEntry["install"] => ({
  kind: "helm",
  repo,
  chart,
  version,
});

const catalogEntries: CatalogEntry[] = [
  {
    id: "cert-manager",
    name: "cert-manager",
    summary: "Gets and renews HTTPS certificates for your apps automatically.",
    slots: ["cluster-basics"],
    homepage: "https://cert-manager.io",
    install: helm("https://charts.jetstack.io", "cert-manager", "v1.0.0-mock"),
    namespace: "cert-manager",
    requires: [],
    inputs: [
      {
        key: "acmeEmail",
        label: "Email for Let's Encrypt",
        help: "Let's Encrypt writes here before a certificate expires.",
        kind: "text",
        required: false,
      },
    ],
    exposesUi: false,
    prerequisites: [],
  },
  {
    id: "traefik",
    name: "Traefik",
    summary: "Routes web traffic from outside the cluster to the right app by hostname.",
    slots: ["cluster-basics"],
    homepage: "https://traefik.io",
    install: helm("https://traefik.github.io/charts", "traefik", "0.0.0-mock"),
    namespace: "traefik",
    requires: [],
    inputs: [],
    exposesUi: false,
    prerequisites: ["Something must send ports 80 and 443 to the cluster: a load balancer, or k3s's built-in one."],
  },
  {
    id: "metrics-server",
    name: "metrics-server",
    summary: "Reports how much CPU and memory each node and pod is using right now.",
    slots: ["cluster-basics"],
    homepage: "https://github.com/kubernetes-sigs/metrics-server",
    install: helm("https://kubernetes-sigs.github.io/metrics-server", "metrics-server", "0.0.0-mock"),
    namespace: "kube-system",
    requires: [],
    inputs: [],
    exposesUi: false,
    prerequisites: [],
  },
  {
    id: "local-path-provisioner",
    name: "Local Path Provisioner",
    summary: "Gives apps storage on the node's own disk, the simplest storage there is.",
    slots: ["cluster-basics"],
    homepage: "https://github.com/rancher/local-path-provisioner",
    install: {
      kind: "manifest",
      url: "https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.0-mock/deploy/local-path-storage.yaml",
      version: "v0.0.0-mock",
    },
    namespace: "local-path-storage",
    requires: [],
    inputs: [{ key: "makeDefault", label: "Make it the default", kind: "boolean", required: false, default: true }],
    exposesUi: false,
    prerequisites: ["Data lives on one node: if that node dies, so does the data. Fine to start with."],
  },
  {
    id: "longhorn",
    name: "Longhorn",
    summary: "Replicated storage across your nodes, with snapshots and backups and a web UI.",
    slots: ["links", "cluster-basics"],
    linkKey: "longhorn",
    homepage: "https://longhorn.io",
    install: {
      kind: "helm",
      repo: "https://charts.longhorn.io",
      chart: "longhorn",
      version: "1.99.0-mock",
      kubeVersion: ">=1.99.0-0",
      fallbacks: [{ version: "1.98.0-mock", kubeVersion: ">=1.25.0-0" }],
    },
    namespace: "longhorn-system",
    requires: [],
    inputs: [host()],
    exposesUi: true,
    prerequisites: ["Every node needs open-iscsi installed and running."],
  },
  {
    id: "rancher",
    name: "Rancher",
    summary: "A full web console for managing Kubernetes clusters.",
    slots: ["links"],
    linkKey: "rancher",
    homepage: "https://www.rancher.com",
    install: helm("https://releases.rancher.com/server-charts/stable", "rancher", "0.0.0-mock"),
    namespace: "cattle-system",
    requires: ["cert-manager"],
    inputs: [
      host(),
      {
        key: "bootstrapPassword",
        label: "First admin password",
        help: "Rancher asks you to change it at first sign-in.",
        kind: "secret",
        required: true,
      },
    ],
    exposesUi: true,
    prerequisites: [],
  },
  {
    id: "headlamp",
    name: "Headlamp",
    summary: "A lightweight web UI for browsing what runs in your cluster.",
    slots: ["links"],
    linkKey: "headlamp",
    homepage: "https://headlamp.dev",
    install: helm("https://kubernetes-sigs.github.io/headlamp", "headlamp", "0.0.0-mock"),
    namespace: "headlamp",
    requires: [],
    inputs: [host()],
    exposesUi: true,
    prerequisites: [],
  },
  {
    id: "gitea",
    name: "Gitea",
    summary: "Your own Git server, like a small GitHub you run yourself.",
    slots: ["links"],
    linkKey: "gitea",
    homepage: "https://about.gitea.com",
    install: helm("oci://docker.gitea.com/charts", "gitea", "0.0.0-mock"),
    namespace: "gitea",
    requires: [],
    inputs: [
      host(),
      { key: "adminUser", label: "Admin username", kind: "text", required: true, default: "gitea-admin" },
      { key: "adminPassword", label: "Admin password", kind: "secret", required: true },
    ],
    exposesUi: true,
    storage: "10Gi",
    prerequisites: [],
    upgradeNotes: [{ version: "0.0.0-mock", note: "The bundled database moves to a new chart; back up first." }],
  },
  {
    id: "grafana",
    name: "Grafana",
    summary: "Dashboards and graphs for metrics and logs.",
    slots: ["links"],
    linkKey: "grafana",
    homepage: "https://grafana.com/oss/grafana",
    install: helm("https://grafana.github.io/helm-charts", "grafana", "0.0.0-mock"),
    namespace: "monitoring",
    requires: [],
    inputs: [host(), { key: "adminPassword", label: "Admin password", kind: "secret", required: true }],
    exposesUi: true,
    storage: "5Gi",
    prerequisites: [],
  },
  {
    id: "authentik",
    name: "Authentik",
    summary: "A sign-in service, so one login with two-factor covers all your apps.",
    slots: ["sign-in"],
    homepage: "https://goauthentik.io",
    install: helm("https://charts.goauthentik.io", "authentik", "0.0.0-mock"),
    namespace: "authentik",
    requires: [],
    inputs: [host(), { key: "adminEmail", label: "Admin email", kind: "text", required: true }],
    exposesUi: true,
    storage: "8Gi",
    prerequisites: [],
  },
  {
    id: "velero",
    name: "Velero",
    summary: "Backs up your apps and their volumes to S3-compatible storage, on a schedule.",
    slots: ["backups"],
    homepage: "https://velero.io",
    install: helm("https://vmware-tanzu.github.io/helm-charts", "velero", "0.0.0-mock"),
    namespace: "velero",
    requires: [],
    inputs: [
      { key: "bucket", label: "Bucket", kind: "text", required: true },
      { key: "s3Url", label: "S3 endpoint", help: "Leave empty for AWS.", kind: "text", required: false },
      { key: "region", label: "Region", kind: "text", required: true, default: "us-east-1" },
      { key: "accessKeyId", label: "Access key ID", kind: "text", required: true },
      { key: "secretAccessKey", label: "Secret access key", kind: "secret", required: true },
    ],
    exposesUi: false,
    prerequisites: ["An S3-compatible bucket: AWS, Backblaze B2, MinIO or a NAS that speaks S3."],
  },
  {
    id: "longhorn-backup-target",
    name: "Longhorn backups",
    summary: "Tells Longhorn where to send volume backups: an NFS share or an S3 bucket.",
    slots: ["backups"],
    homepage: "https://longhorn.io/docs/latest/snapshots-and-backups/backup-and-restore/set-backup-target/",
    install: { kind: "patch", target: "longhorn.io BackupTarget default" },
    namespace: "longhorn-system",
    requires: ["longhorn"],
    inputs: [
      {
        key: "target",
        label: "Backup target",
        help: "nfs://server:/export/path or s3://bucket@region/",
        kind: "text",
        required: true,
      },
    ],
    exposesUi: false,
    prerequisites: [],
  },
  {
    id: "ntfy",
    name: "ntfy",
    summary: "Sends alerts as push notifications to your phone, no account needed.",
    slots: ["notifications"],
    homepage: "https://ntfy.sh",
    install: {
      kind: "manifest",
      bundled: ["apiVersion: v1", "kind: Namespace", "metadata:", "  name: ntfy", ""].join("\n"),
      version: "v0.0.0-mock",
    },
    namespace: "ntfy",
    requires: [],
    inputs: [host()],
    exposesUi: true,
    storage: "1Gi",
    prerequisites: [],
  },
  {
    id: "cloudflared",
    name: "Cloudflare Tunnel",
    summary: "Reaches this app from the internet through Cloudflare without opening ports.",
    slots: ["remote-access"],
    homepage: "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/",
    install: helm("https://cloudflare.github.io/helm-charts", "cloudflare-tunnel-remote", "0.0.0-mock"),
    namespace: "cloudflared",
    requires: [],
    inputs: [
      {
        key: "tunnelToken",
        label: "Tunnel token",
        help: "Create a tunnel in the Cloudflare dashboard and paste its token.",
        kind: "secret",
        required: true,
      },
    ],
    exposesUi: false,
    prerequisites: ["A domain on Cloudflare."],
  },
  {
    id: "tailscale-operator",
    name: "Tailscale",
    summary: "Reaches this app from your own devices over a private network, nothing exposed to the internet.",
    slots: ["remote-access"],
    homepage: "https://tailscale.com/kb/1236/kubernetes-operator",
    install: helm("https://pkgs.tailscale.com/helmcharts", "tailscale-operator", "0.0.0-mock"),
    namespace: "tailscale",
    requires: [],
    inputs: [
      { key: "clientId", label: "OAuth client ID", kind: "text", required: true },
      { key: "clientSecret", label: "OAuth client secret", kind: "secret", required: true },
    ],
    exposesUi: false,
    prerequisites: ["A Tailscale account and an OAuth client with the Devices Core and Auth Keys scopes."],
  },
];

const GiB = 1024 ** 3;

// Volumes from `storage` ("10Gi"), and half a GiB of images per app.
export const mockCatalog: readonly CatalogEntry[] = catalogEntries.map((entry) =>
  entry.install.kind === "patch"
    ? entry
    : {
        ...entry,
        disk: { volumeBytes: entry.storage ? Number.parseInt(entry.storage, 10) * GiB : 0, imageBytes: GiB / 2 },
      }
);

const absent = (appId: string): DetectedApp => ({
  appId,
  state: "not-installed",
  urls: [],
  evidence: "No matching Deployment, StatefulSet or DaemonSet",
  managedBy: null,
  ownedByUs: false,
});

// Longhorn and Grafana installed (Grafana by Fleet), cert-manager and
// Traefik present, metrics-server unreadable; everything else missing.
export const mockDetected: DetectedApp[] = mockCatalog.map((entry): DetectedApp => {
  switch (entry.id) {
    case "longhorn":
      return {
        appId: "longhorn",
        state: "installed",
        namespace: "longhorn-system",
        release: "longhorn",
        version: "1.9.1",
        urls: ["https://longhorn.example.test"],
        evidence: "Deployment longhorn-system/longhorn-ui (app.kubernetes.io/name=longhorn-ui)",
        managedBy: "helm",
        ownedByUs: false,
      };
    case "grafana":
      return {
        appId: "grafana",
        state: "installed",
        namespace: "monitoring",
        version: "12.1.0",
        urls: ["https://grafana.example.test"],
        evidence: "Deployment monitoring/grafana (app.kubernetes.io/name=grafana)",
        managedBy: "fleet",
        ownedByUs: false,
      };
    case "cert-manager":
      return {
        appId: "cert-manager",
        state: "installed",
        namespace: "cert-manager",
        release: "cert-manager",
        version: "v1.18.2",
        urls: [],
        evidence: "Deployment cert-manager/cert-manager (app.kubernetes.io/name=cert-manager)",
        managedBy: "helm",
        ownedByUs: false,
      };
    case "traefik":
      return {
        appId: "traefik",
        state: "installed",
        namespace: "kube-system",
        release: "traefik",
        urls: [],
        evidence: "Deployment kube-system/traefik (app.kubernetes.io/name=traefik)",
        managedBy: "helm",
        ownedByUs: false,
      };
    case "metrics-server":
      return {
        appId: "metrics-server",
        state: "unknown",
        urls: [],
        evidence: "Deployments in kube-system could not be listed",
        managedBy: null,
        ownedByUs: false,
      };
    default:
      return absent(entry.id);
  }
});

export const mockIngressHosts: IngressHost[] = [
  {
    host: "grafana.example.test",
    url: "https://grafana.example.test",
    tls: true,
    namespace: "monitoring",
    ingress: "grafana",
    service: "grafana",
    serviceUrl: "http://grafana.monitoring.svc:80",
    ingressClass: "traefik",
    appId: "grafana",
  },
  {
    host: "longhorn.example.test",
    url: "https://longhorn.example.test",
    tls: true,
    namespace: "longhorn-system",
    ingress: "longhorn-ingress",
    service: "longhorn-frontend",
    serviceUrl: "http://longhorn-frontend.longhorn-system.svc:80",
    ingressClass: "traefik",
    appId: "longhorn",
  },
  {
    host: "jellyfin.example.test",
    url: "http://jellyfin.example.test",
    tls: false,
    namespace: "media",
    ingress: "jellyfin",
    service: "jellyfin",
    ingressClass: "traefik",
  },
];

export const mockDiscovery: DiscoveryReport = {
  checkedAt: new Date(MOCK_NOW).toISOString(),
  kubernetesVersion: "v1.31.4+k3s1",
  apps: mockDetected,
  ingressHosts: mockIngressHosts,
  nodeDisks: [
    { node: "node-1", availableBytes: 60 * GiB, capacityBytes: 100 * GiB },
    { node: "node-2", availableBytes: 40 * GiB, capacityBytes: 100 * GiB },
  ],
  basics: [
    {
      id: "default-storage-class",
      label: "Default storage class",
      status: "warn",
      detail: "2 storage classes are marked default (longhorn, local-path); new volumes pick one at random",
      found: ["longhorn", "local-path"],
      fixAppIds: [],
    },
    {
      id: "ingress-controller",
      label: "Ingress controller",
      status: "ok",
      detail: "IngressClass traefik (default)",
      found: ["traefik"],
      fixAppIds: [],
    },
    {
      id: "cert-manager",
      label: "cert-manager",
      status: "ok",
      detail: "cert-manager v1.18.2 with ClusterIssuer letsencrypt-prod",
      found: ["letsencrypt-prod"],
      fixAppIds: [],
    },
    {
      id: "metrics-server",
      label: "metrics-server",
      status: "crit",
      detail: "metrics.k8s.io is not served: live CPU and memory need metrics-server or kubelet access",
      found: [],
      fixAppIds: ["metrics-server"],
    },
  ],
  suggested: {
    storageClass: "longhorn",
    ingressClass: "traefik",
    clusterIssuer: "letsencrypt-prod",
    baseDomain: "example.test",
    ingressService: "http://traefik.kube-system.svc.cluster.local:80",
    ingressAddress: "10.0.0.20",
  },
};

export const mockCatalogApps: CatalogAppView[] = mockCatalog.map((entry) => ({
  ...entry,
  detected: mockDetected.find((d) => d.appId === entry.id)!,
}));

export const mockBundle: CatalogBundle = {
  id: "self-hosted",
  name: "Deploy bundle",
  summary: "Everything a small self-hosted cluster needs, with sensible defaults.",
  inputs: [
    {
      key: "baseDomain",
      label: "Base domain",
      help: "Apps get names under it, like git.example.test.",
      kind: "text",
      required: true,
    },
    { key: "adminEmail", label: "Admin email", kind: "text", required: true },
    { key: "adminPassword", label: "Admin password", kind: "secret", required: true },
    {
      key: "storageClass",
      label: "Storage class",
      help: "Where apps keep their data. Leave empty for the cluster's default.",
      kind: "text",
      required: false,
    },
  ],
  items: [
    { appId: "traefik", required: true, bind: {}, values: {} },
    { appId: "cert-manager", required: true, bind: { acmeEmail: "adminEmail" }, values: {} },
    { appId: "metrics-server", required: true, bind: {}, values: {} },
    { appId: "local-path-provisioner", required: true, bind: {}, values: { makeDefault: true } },
    {
      appId: "longhorn",
      required: false,
      hostPrefix: "longhorn",
      bind: {},
      values: {},
      note: "Every node needs open-iscsi; untick it if yours don't have it.",
    },
    { appId: "authentik", required: true, hostPrefix: "auth", bind: { adminEmail: "adminEmail" }, values: {} },
    {
      appId: "gitea",
      required: true,
      hostPrefix: "git",
      bind: { adminPassword: "adminPassword" },
      values: { adminUser: "gitea-admin" },
    },
    { appId: "grafana", required: true, hostPrefix: "grafana", bind: { adminPassword: "adminPassword" }, values: {} },
    { appId: "headlamp", required: true, hostPrefix: "headlamp", bind: {}, values: {} },
    { appId: "ntfy", required: true, hostPrefix: "ntfy", bind: {}, values: {} },
  ],
};

// Against mockDiscovery: Traefik, cert-manager, Longhorn and Grafana are
// there already, and storage classes are marked default; metrics-server is
// unknown, so it stays in.
export const mockBundleView: CatalogBundleView = {
  ...mockBundle,
  suggested: { baseDomain: mockDiscovery.suggested.baseDomain, storageClass: mockDiscovery.suggested.storageClass },
  items: mockBundle.items.map((item): BundleItemView => {
    const detected = mockDetected.find((d) => d.appId === item.appId)!;
    const skip = detected.state === "installed" || item.appId === "local-path-provisioner";
    const selected = !skip;
    return {
      ...item,
      detected,
      skip,
      selected,
      ...(skip ? { reason: "Already installed" } : selected ? {} : { reason: item.note }),
    };
  }),
};

// A CatalogService over the mock catalog, for modules that look it up
// (deploy) and for HTTP tests of the catalog routes' consumers.
export function createMockCatalogService(
  options: { entries?: readonly CatalogEntry[]; discovery?: DiscoveryReport; bundles?: readonly CatalogBundle[] } = {}
): CatalogService {
  const entries = options.entries ?? mockCatalog;
  const discovery = options.discovery ?? mockDiscovery;
  return {
    entries: () => entries,
    get: (appId) => entries.find((entry) => entry.id === appId),
    bundles: () => options.bundles ?? [mockBundle],
    discover: async () => structuredClone(discovery),
  };
}

export const mockDeployStatus: DeployStatus = {
  enabled: true,
  namespace: "console",
  installerServiceAccount: "console-installer",
  image: "docker.io/alpine/k8s@sha256:0000000000000000000000000000000000000000000000000000000000000000",
  defaults: {
    storageClass: mockDiscovery.suggested.storageClass,
    ingressClass: mockDiscovery.suggested.ingressClass,
    clusterIssuer: mockDiscovery.suggested.clusterIssuer,
    baseDomain: mockDiscovery.suggested.baseDomain,
  },
};

export const mockAccess: AccessView = {
  mode: "cloudflare-tunnel",
  baseDomain: "example.test",
  appId: "cloudflared",
  appInstalled: false,
  hosts: [
    { appId: "grafana", host: "grafana.example.test", url: "https://grafana.example.test", resolves: true },
    { appId: "longhorn", host: "longhorn.example.test", url: "https://longhorn.example.test", resolves: false },
  ],
  wildcard: "*.example.test",
  ingressService: "http://traefik.kube-system.svc.cluster.local:80",
};

export const mockAccessLocal: AccessView = {
  mode: "local",
  baseDomain: "example.test",
  hosts: [
    { appId: "grafana", host: "grafana.example.test", url: "http://grafana.example.test", resolves: false },
    { appId: "longhorn", host: "longhorn.example.test", url: "http://longhorn.example.test", resolves: false },
  ],
  ingressAddress: "10.0.0.20",
  hostsFile: "10.0.0.20 grafana.example.test\n10.0.0.20 longhorn.example.test\n",
};

export const mockDeployDisabled: DeployStatus = {
  ...mockDeployStatus,
  enabled: false,
  enableHint: "helm upgrade app oci://example.test/charts/app -n app --reuse-values --set deploy.enabled=true",
};

export const mockDeployPlan: DeployPlan = {
  appId: "headlamp",
  release: "headlamp",
  namespace: "headlamp",
  version: "0.0.0-mock",
  allowed: true,
  missingRequires: [],
  inputs: { host: "headlamp.example.test" },
  inputErrors: {},
  commands: [
    "helm upgrade --install headlamp headlamp --repo https://kubernetes-sigs.github.io/headlamp " +
      "--version 0.0.0-mock --namespace headlamp --create-namespace --values /values/values.yaml --wait --timeout 10m",
  ],
  values: [
    "ingress:",
    "  enabled: true",
    "  ingressClassName: traefik",
    "  annotations:",
    "    cert-manager.io/cluster-issuer: letsencrypt-prod",
    "  hosts:",
    "    - host: headlamp.example.test",
    "      paths: [{ path: /, type: Prefix }]",
    "  tls:",
    "    - hosts: [headlamp.example.test]",
    "      secretName: headlamp-tls",
    "",
  ].join("\n"),
  creates: [
    { kind: "Namespace", name: "headlamp" },
    { kind: "Secret", name: "deploy-headlamp-values", namespace: "console" },
    { kind: "Job", name: "deploy-headlamp-1", namespace: "console" },
  ],
  url: "https://headlamp.example.test",
  warnings: [],
};

export const mockBlockedPlan: DeployPlan = {
  ...mockDeployPlan,
  appId: "rancher",
  release: "rancher",
  namespace: "cattle-system",
  allowed: false,
  blockedBy: "host: required",
  inputs: { host: "", bootstrapPassword: "********" },
  inputErrors: { host: "required" },
  url: undefined,
  warnings: [],
};

export const mockDeployJob: DeployJobView = {
  id: "dj_1",
  appId: "headlamp",
  release: "headlamp",
  namespace: "headlamp",
  version: "0.0.0-mock",
  mode: "install",
  state: "succeeded",
  startedBy: "admin",
  createdAt: isoAgo(HOUR),
  startedAt: isoAgo(HOUR - 5_000),
  finishedAt: isoAgo(HOUR - 95_000),
  message: 'Release "headlamp" has been upgraded. Happy Helming!',
  url: "https://headlamp.example.test",
  job: { namespace: "console", name: "deploy-headlamp-1" },
};

export const mockRunningJob: DeployJobView = {
  ...mockDeployJob,
  id: "dj_2",
  appId: "metrics-server",
  release: "metrics-server",
  namespace: "kube-system",
  state: "running",
  createdAt: isoAgo(30_000),
  startedAt: isoAgo(25_000),
  finishedAt: undefined,
  message: undefined,
  url: undefined,
  job: { namespace: "console", name: "deploy-metrics-server-2" },
};

export const mockFailedJob: DeployJobView = {
  ...mockDeployJob,
  id: "dj_3",
  appId: "longhorn",
  release: "longhorn",
  namespace: "longhorn-system",
  state: "failed",
  createdAt: isoAgo(2 * HOUR),
  startedAt: isoAgo(2 * HOUR - 5_000),
  finishedAt: isoAgo(2 * HOUR - 600_000),
  message: "Error: context deadline exceeded: longhorn-manager pods not Ready (open-iscsi missing on node-2?)",
  url: undefined,
  job: { namespace: "console", name: "deploy-longhorn-3" },
};

export const mockDeployLog: string[] = [
  'Release "headlamp" does not exist. Installing it now.',
  "NAME: headlamp",
  "STATUS: deployed",
  'Release "headlamp" has been upgraded. Happy Helming!',
];

export const mockHostKeypair: HostKeypair = {
  publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockMockMockMockMockMockMockMockMockMockMock app@cluster",
  fingerprint: "SHA256:TW9ja0tleXBhaXJGaW5nZXJwcmludEZvclRlc3RpbmdPbmx5",
  createdAt: isoAgo(HOUR),
  installCommand:
    "umask 077 && mkdir -p ~/.ssh && echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockMockMockMockMockMockMockMockMockMockMock app@cluster' >> ~/.ssh/authorized_keys",
};

export const mockBundlePlan: BundlePlan = {
  bundleId: mockBundle.id,
  allowed: true,
  steps: mockBundleView.items.map((item) =>
    item.skip || !item.selected
      ? { appId: item.appId, skip: true, reason: item.reason ?? "Left out" }
      : item.appId === "headlamp"
        ? { appId: item.appId, skip: false, plan: mockDeployPlan }
        : {
            appId: item.appId,
            skip: false,
            plan: { ...mockDeployPlan, appId: item.appId, release: item.appId, namespace: item.appId },
          }
  ),
};
mockBundlePlan.disk = checkDisk(
  mockBundlePlan.steps
    .filter((step) => !step.skip)
    .map((step) => mockCatalog.find((e) => e.id === step.appId)?.disk ?? { volumeBytes: 0, imageBytes: 0 }),
  mockDiscovery.nodeDisks
);

// The same rollout on one small node that can't hold it.
const smallNode = [{ node: "node-1", availableBytes: 6 * GiB, capacityBytes: 30 * GiB }];
const noRoom = checkDisk(
  mockBundlePlan.steps
    .filter((step) => !step.skip)
    .map((step) => mockCatalog.find((e) => e.id === step.appId)?.disk ?? { volumeBytes: 0, imageBytes: 0 }),
  smallNode
);
export const mockBundlePlanNoRoom: BundlePlan = {
  ...mockBundlePlan,
  allowed: false,
  blockedBy: noRoom.detail,
  disk: noRoom,
};

// Halfway: metrics-server and Authentik done, Gitea installing.
export const mockBundleRun: BundleRunView = {
  id: "br_1",
  bundleId: mockBundle.id,
  state: "running",
  startedBy: "admin",
  createdAt: isoAgo(10 * 60_000),
  steps: mockBundlePlan.steps.map((step) => {
    if (step.skip) return { appId: step.appId, state: "skipped" as const, message: step.reason };
    if (step.appId === "metrics-server" || step.appId === "authentik") {
      return { appId: step.appId, state: "succeeded" as const, jobId: `dj_${step.appId}` };
    }
    if (step.appId === "gitea") return { appId: step.appId, state: "running" as const, jobId: "dj_gitea" };
    return { appId: step.appId, state: "pending" as const };
  }),
};

// Gitea can move up, Headlamp is current, Longhorn's pin needs a newer
// Kubernetes so it stays on the fallback, ntfy's version is unknown, and
// metrics-server has a job running.
export const mockUpgradeReport: UpgradeReport = {
  checkedAt: new Date(MOCK_NOW).toISOString(),
  kubernetesVersion: "v1.31.4+k3s1",
  enabled: true,
  apps: [
    {
      appId: "metrics-server",
      release: "metrics-server",
      namespace: "kube-system",
      currentVersion: "0.0.0-mock",
      pinnedVersion: "0.0.0-mock",
      targetVersion: "0.0.0-mock",
      fellBack: false,
      state: "blocked",
      reason: "A deploy job for metrics-server is running.",
      notes: [],
      commands: [],
    },
    {
      appId: "longhorn",
      release: "longhorn",
      namespace: "longhorn-system",
      currentVersion: "1.98.0-mock",
      pinnedVersion: "1.99.0-mock",
      targetVersion: "1.98.0-mock",
      fellBack: true,
      state: "current",
      reason: "1.99.0-mock needs Kubernetes >=1.34.0-0; this cluster runs v1.31.4+k3s1.",
      notes: [],
      commands: [],
      url: "https://longhorn.example.test",
    },
    {
      appId: "headlamp",
      release: "headlamp",
      namespace: "headlamp",
      currentVersion: "0.0.0-mock",
      pinnedVersion: "0.0.0-mock",
      targetVersion: "0.0.0-mock",
      fellBack: false,
      state: "current",
      reason: "Already at the catalog's version.",
      notes: [],
      commands: [],
      url: "https://headlamp.example.test",
    },
    {
      appId: "gitea",
      release: "gitea",
      namespace: "gitea",
      currentVersion: "0.0.0-alpha",
      pinnedVersion: "0.0.0-mock",
      targetVersion: "0.0.0-mock",
      fellBack: false,
      state: "available",
      notes: [{ version: "0.0.0-mock", note: "The bundled database moves to a new chart; back up first." }],
      commands: [
        "helm upgrade gitea oci://docker.gitea.com/charts/gitea --version 0.0.0-mock --namespace gitea " +
          "--reset-then-reuse-values --wait --timeout 10m",
      ],
      url: "https://gitea.example.test",
    },
    {
      appId: "ntfy",
      release: "ntfy",
      namespace: "ntfy",
      pinnedVersion: "v0.0.0-mock",
      targetVersion: "v0.0.0-mock",
      fellBack: false,
      state: "unknown",
      reason: "No record of the version installed here.",
      notes: [],
      commands: ["kubectl apply -f /values/manifest.yaml"],
      url: "https://ntfy.example.test",
    },
  ],
};

export const mockUpgradeRun: BundleRunView = {
  id: "br_2",
  bundleId: UPGRADE_RUN,
  state: "running",
  startedBy: "admin",
  createdAt: isoAgo(60_000),
  steps: [{ appId: "gitea", state: "running", jobId: "dj_4" }],
};

export const mockReplicasPlan: DeployActionPlan = {
  kind: "longhorn-replicas",
  title: "Raise Longhorn replicas to 2",
  allowed: true,
  steps: [
    {
      label: "Set Longhorn's StorageClass and default replica count to 2",
      commands: [
        "helm upgrade longhorn longhorn --repo https://charts.longhorn.io --version 0.0.0-mock " +
          "--namespace longhorn-system --reuse-values --values /values/replicas.yaml --wait --timeout 10m",
        "kubectl patch settings.longhorn.io default-replica-count --namespace longhorn-system --type merge " +
          "--patch-file /values/setting.yaml",
      ],
    },
    {
      label: "Raise 2 existing volumes to 2 replicas",
      commands: [
        "kubectl patch volumes.longhorn.io pvc-0b7c --namespace longhorn-system --type merge " +
          "--patch-file /values/volume.yaml",
        "kubectl patch volumes.longhorn.io pvc-91ae --namespace longhorn-system --type merge " +
          "--patch-file /values/volume.yaml",
      ],
    },
  ],
  rollback:
    "Nothing is lowered: a failed step leaves the earlier ones raised, and running it again picks up where it stopped.",
  changes: [
    { kind: "Setting", name: "default-replica-count", namespace: "longhorn-system" },
    { kind: "StorageClass", name: "longhorn" },
    { kind: "Volume", name: "pvc-0b7c", namespace: "longhorn-system" },
    { kind: "Volume", name: "pvc-91ae", namespace: "longhorn-system" },
  ],
  creates: [
    { kind: "Job", name: "deploy-longhorn-7", namespace: "console" },
    { kind: "Secret", name: "deploy-longhorn-values", namespace: "console" },
  ],
  warnings: ["Each raised volume copies its data to the new node; expect disk and network load while it rebuilds."],
};

export const mockReplicasJob: DeployJobView = {
  ...mockRunningJob,
  id: "dj_7",
  appId: "longhorn",
  release: "longhorn",
  namespace: "longhorn-system",
  mode: "action",
  action: "longhorn-replicas",
  job: { namespace: "console", name: "deploy-longhorn-7" },
};

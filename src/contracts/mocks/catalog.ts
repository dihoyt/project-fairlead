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
import type { BundlePlan, BundleRunView, DeployJobView, DeployPlan, DeployStatus } from "../deploy.js";
import type { HostKeypair } from "../hosts.js";
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

export const mockCatalog: readonly CatalogEntry[] = [
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
    install: helm("https://charts.longhorn.io", "longhorn", "0.0.0-mock"),
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
    appId: "grafana",
  },
  {
    host: "longhorn.example.test",
    url: "https://longhorn.example.test",
    tls: true,
    namespace: "longhorn-system",
    ingress: "longhorn-ingress",
    service: "longhorn-frontend",
    appId: "longhorn",
  },
  {
    host: "jellyfin.example.test",
    url: "http://jellyfin.example.test",
    tls: false,
    namespace: "media",
    ingress: "jellyfin",
    service: "jellyfin",
  },
];

export const mockDiscovery: DiscoveryReport = {
  checkedAt: new Date(MOCK_NOW).toISOString(),
  apps: mockDetected,
  ingressHosts: mockIngressHosts,
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
      note: "Every node needs open-iscsi; tick it once yours do.",
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
    const selected = !skip && (item.required || item.appId !== "longhorn");
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
  defaults: { ...mockDiscovery.suggested },
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

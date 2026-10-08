import type { CatalogEntry, CatalogInput, DiskFootprint, InstallSource } from "../../contracts/catalog.js";
import { NTFY_VERSION, ntfyManifest } from "./manifests/ntfy.js";

// Versions are pinned to stable releases; moving one is a catalog change,
// reviewed like any other.

const host = (): CatalogInput => ({
  key: "host",
  label: "Hostname",
  help: "The address it will answer on. Point DNS for it at your ingress.",
  kind: "hostname",
  required: true,
});

// kubeVersion is the chart's own constraint for that version, copied from
// its Chart.yaml; charts that declare none leave it out.
const helm = (
  repo: string,
  chart: string,
  version: string,
  more: { kubeVersion?: string; fallbacks?: Array<{ version: string; kubeVersion?: string }> } = {}
): InstallSource => ({ kind: "helm", repo, chart, version, ...more });

const entries: CatalogEntry[] = [
  {
    id: "cert-manager",
    name: "cert-manager",
    summary: "Gets and renews HTTPS certificates for your apps automatically.",
    slots: ["cluster-basics"],
    homepage: "https://cert-manager.io",
    install: helm("https://charts.jetstack.io", "cert-manager", "v1.21.2"),
    namespace: "cert-manager",
    requires: [],
    inputs: [
      {
        key: "acmeEmail",
        label: "Email for Let's Encrypt",
        help: "Let's Encrypt writes here before a certificate expires. Leave empty to add an issuer yourself.",
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
    install: helm("https://traefik.github.io/charts", "traefik", "41.6.1", { kubeVersion: ">=1.25.0-0" }),
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
    install: helm("https://kubernetes-sigs.github.io/metrics-server", "metrics-server", "3.14.0"),
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
      url: "https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.37/deploy/local-path-storage.yaml",
      version: "v0.0.37",
    },
    namespace: "local-path-storage",
    requires: [],
    inputs: [
      {
        key: "makeDefault",
        label: "Make it the default",
        help: "Volumes that name no storage class land here.",
        kind: "boolean",
        required: false,
        default: true,
      },
    ],
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
    install: helm("https://charts.longhorn.io", "longhorn", "1.13.0", {
      kubeVersion: ">=1.34.0-0",
      fallbacks: [{ version: "1.12.1", kubeVersion: ">=1.25.0-0" }],
    }),
    namespace: "longhorn-system",
    requires: [],
    inputs: [host()],
    exposesUi: true,
    noLogin: true,
    prerequisites: [
      "Every node needs open-iscsi installed and running.",
      "Every node needs an NFSv4 client for volumes shared between pods.",
    ],
  },
  {
    id: "rancher",
    name: "Rancher",
    summary: "A full web console for managing Kubernetes clusters.",
    slots: ["links"],
    linkKey: "rancher",
    homepage: "https://www.rancher.com",
    install: helm("https://releases.rancher.com/server-charts/stable", "rancher", "2.15.2", {
      kubeVersion: "<1.37.0-0",
    }),
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
    prerequisites: ["Rancher wants at least 4 GB of free memory in the cluster."],
  },
  {
    id: "headlamp",
    name: "Headlamp",
    summary: "A lightweight web UI for browsing what runs in your cluster.",
    slots: ["links"],
    linkKey: "headlamp",
    homepage: "https://headlamp.dev",
    install: helm("https://kubernetes-sigs.github.io/headlamp", "headlamp", "0.45.0"),
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
    install: helm("oci://docker.gitea.com/charts", "gitea", "12.7.0"),
    namespace: "gitea",
    requires: [],
    inputs: [
      host(),
      { key: "adminUser", label: "Admin username", kind: "text", required: true, default: "gitea-admin" },
      { key: "adminPassword", label: "Admin password", kind: "secret", required: true },
    ],
    exposesUi: true,
    storage: "5Gi",
    prerequisites: [],
  },
  {
    id: "grafana",
    name: "Grafana",
    summary: "Dashboards and graphs for metrics and logs.",
    slots: ["links"],
    linkKey: "grafana",
    homepage: "https://grafana.com/oss/grafana",
    install: helm("https://grafana-community.github.io/helm-charts", "grafana", "13.3.1", { kubeVersion: "^1.25.0-0" }),
    namespace: "monitoring",
    requires: [],
    inputs: [host(), { key: "adminPassword", label: "Admin password", kind: "secret", required: true }],
    exposesUi: true,
    storage: "2Gi",
    prerequisites: [],
  },
  {
    id: "authentik",
    name: "Authentik",
    summary: "A sign-in service, so one login with two-factor covers all your apps.",
    slots: ["sign-in"],
    homepage: "https://goauthentik.io",
    install: helm("https://charts.goauthentik.io", "authentik", "2026.8.3"),
    namespace: "authentik",
    requires: [],
    inputs: [
      host(),
      { key: "adminEmail", label: "Admin email", kind: "text", required: true },
      {
        key: "adminPassword",
        label: "Admin password",
        help: "For the akadmin account. Leave empty to set it in Authentik's first-run page instead.",
        kind: "secret",
        required: false,
      },
    ],
    exposesUi: true,
    storage: "4Gi",
    prerequisites: [],
  },
  {
    id: "velero",
    name: "Velero",
    summary: "Backs up your apps and their volumes to S3-compatible storage, on a schedule.",
    slots: ["backups"],
    homepage: "https://velero.io",
    install: helm("https://vmware-tanzu.github.io/helm-charts", "velero", "12.2.0", { kubeVersion: ">=1.16.0-0" }),
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
    prerequisites: ["The NFS export or bucket must already exist and be reachable from every node."],
  },
  {
    id: "ntfy",
    name: "ntfy",
    summary: "Sends alerts as push notifications to your phone, no account needed.",
    slots: ["notifications"],
    homepage: "https://ntfy.sh",
    install: { kind: "manifest", bundled: ntfyManifest, version: NTFY_VERSION },
    namespace: "ntfy",
    requires: [],
    inputs: [host()],
    exposesUi: true,
    storage: "512Mi",
    prerequisites: [],
  },
  {
    id: "cloudflared",
    name: "Cloudflare Tunnel",
    summary: "Reaches this app from the internet through Cloudflare without opening ports.",
    slots: ["remote-access"],
    homepage: "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/",
    install: helm("https://cloudflare.github.io/helm-charts", "cloudflare-tunnel-remote", "0.1.2"),
    namespace: "cloudflared",
    requires: [],
    inputs: [
      {
        key: "tunnelToken",
        label: "Tunnel token",
        help: "In Cloudflare Zero Trust, Networks > Tunnels > Create a tunnel (Cloudflared), then copy the token from the install command.",
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
    install: helm("https://pkgs.tailscale.com/helmcharts", "tailscale-operator", "1.104.1"),
    namespace: "tailscale",
    requires: [],
    inputs: [
      { key: "clientId", label: "OAuth client ID", kind: "text", required: true },
      { key: "clientSecret", label: "OAuth client secret", kind: "secret", required: true },
    ],
    exposesUi: false,
    prerequisites: [
      "A Tailscale account with MagicDNS and HTTPS certificates turned on (admin console > DNS).",
      'Tags in the tailnet policy: "tag:k8s-operator" owned by you, and "tag:k8s" owned by "tag:k8s-operator".',
      "An OAuth client with the Devices Core and Auth Keys write scopes and the tag:k8s-operator tag.",
    ],
  },
];

// Unpacked image sizes of each pinned version, rounded up, in MiB: every
// image a default install pulls, sidecars included. Images a DaemonSet
// runs (Longhorn, Velero's node agent) land on every node; counted once.
const imageMiB: Record<string, number> = {
  "cert-manager": 300,
  traefik: 200,
  "metrics-server": 80,
  "local-path-provisioner": 80,
  longhorn: 2600,
  rancher: 3000,
  headlamp: 250,
  gitea: 250,
  grafana: 500,
  // The server image and Postgres.
  authentik: 1300,
  // Velero, its AWS plugin and the node agent (same image).
  velero: 350,
  ntfy: 60,
  cloudflared: 80,
  "tailscale-operator": 250,
};

// Memory each default install asks for, in MiB: the requests ../deploy/apps.ts
// sets, or rough idle use where the chart sets none (Longhorn on one node,
// Traefik, metrics-server). cloudflared counts its two replicas.
const memoryMiB: Record<string, number> = {
  "cert-manager": 120,
  traefik: 64,
  "metrics-server": 48,
  "local-path-provisioner": 16,
  longhorn: 640,
  gitea: 160,
  authentik: 1056,
  ntfy: 32,
  cloudflared: 64,
  "tailscale-operator": 64,
};

const MiB = 1024 ** 2;
const UNITS: Record<string, number> = { Mi: MiB, Gi: 1024 * MiB, Ti: 1024 * 1024 * MiB };

const quantity = (size: string | undefined): number => {
  const m = /^(\d+)(Mi|Gi|Ti)$/.exec(size ?? "");
  return m ? Number(m[1]) * UNITS[m[2]!]! : 0;
};

// Volumes are the app's `storage`: no default install here creates a second PVC.
const footprint = (entry: CatalogEntry): DiskFootprint => ({
  volumeBytes: quantity(entry.storage),
  imageBytes: (imageMiB[entry.id] ?? 0) * MiB,
});

export const catalog: readonly CatalogEntry[] = entries.map((entry) => {
  if (entry.install.kind === "patch") return entry;
  const memory = memoryMiB[entry.id];
  return { ...entry, disk: footprint(entry), ...(memory ? { memoryBytes: memory * MiB } : {}) };
});

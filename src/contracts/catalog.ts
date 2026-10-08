// The app catalog and cluster discovery (module "catalog"). The catalog is
// fixed data in code: every app a first-timer can deploy from the wizard,
// with what it installs and how to tell it is already there. Discovery is
// read-only: it looks at the cluster and says which catalog apps are
// installed, which Ingress hosts exist, and which cluster basics are missing.
//
// Server-free on purpose: the client imports this file.

import type { Status } from "./health.js";
import type { UpgradeNote } from "./deploy.js";
import type { ManagedBy } from "./k8s.js";

// Where in the wizard an app is offered. One app can be offered in several.
export type CatalogSlot =
  | "links" // the tools step: Rancher, Headlamp, Longhorn UI, Gitea, Grafana
  | "sign-in" // an identity provider for the OIDC step
  | "cluster-basics" // storage class, ingress controller, cert-manager, metrics-server
  | "backups" // offered from findings: no backups
  | "notifications" // a push service for people with no channel yet
  | "remote-access"; // reaching the app from outside: tunnel or tailnet

// The wizard's Links step fields an app fills once it is installed or found.
export type LinkKey = "rancher" | "headlamp" | "longhorn" | "gitea" | "grafana";

export type CatalogInputKind = "text" | "hostname" | "secret" | "select" | "boolean" | "size";

// Applies only while another input of the same form (a bundle's shared
// inputs) has one of these values: the tunnel token only when "access" is
// "cloudflare-tunnel".
export interface InputCondition {
  input: string;
  in: string[];
}

export interface CatalogInput {
  // Stable within the app: "host", "adminEmail", "tunnelToken".
  key: string;
  label: string;
  // One plain sentence under the field.
  help?: string;
  kind: CatalogInputKind;
  required: boolean;
  // Literal default. A default the server derives (a host under the base
  // domain, the default storage class) is filled in by POST /api/deploy/plan.
  default?: string | boolean;
  // "select" only.
  options?: Array<{ value: string; label: string }>;
  // Shown, validated and required only while the condition holds; ignored
  // otherwise.
  when?: InputCondition;
}

// What a deploy runs, shown to the user before it does. Every command line is
// built from a fixed template in the deploy module from these fields and the
// validated inputs, never from request text.
export type InstallSource =
  | {
      kind: "helm";
      // https or oci:// chart repository.
      repo: string;
      chart: string;
      // Pinned; a catalog change is how an app's version moves.
      version: string;
      // The chart's own kubeVersion constraint (">=1.25.0-0"), when it has one.
      kubeVersion?: string;
      // Older pins to fall back to, newest first, when the cluster is outside
      // `kubeVersion`. pickVersion() (./kubeversion.ts) makes the choice.
      fallbacks?: Array<{ version: string; kubeVersion?: string }>;
    }
  | {
      // Plain manifests, exactly one of: a pinned, published URL
      // (local-path-provisioner), or YAML shipped in the catalog itself
      // (ntfy, which has no upstream manifest). A bundled manifest carries
      // no Ingress; the deploy module renders one from the "host" input.
      kind: "manifest";
      url?: string;
      bundled?: string;
      version: string;
      kubeVersion?: string;
    }
  | {
      // A change to something already installed, from a fixed template:
      // marking a storage class default, setting Longhorn's backup target.
      kind: "patch";
      target: string;
    };

export interface CatalogEntry {
  // "grafana", "cert-manager", "longhorn-backup-target".
  id: string;
  name: string;
  // The "What is this?" line: one plain sentence for someone who has never
  // heard of it.
  summary: string;
  slots: CatalogSlot[];
  linkKey?: LinkKey;
  homepage: string;
  install: InstallSource;
  // Namespace it installs into unless the request names another.
  namespace: string;
  // Other catalog ids that must be installed first (Rancher needs cert-manager).
  requires: string[];
  inputs: CatalogInput[];
  // Has a web UI that gets an Ingress; its URL fills the Links step and
  // becomes a proposed HTTP check.
  exposesUi: boolean;
  // Persistent volume size it asks for by default, when it keeps data: "10Gi".
  storage?: string;
  // Disk it takes once installed with these defaults, for the disk-space
  // preflight (./disk.ts). Absent for a patch, which installs nothing.
  disk?: DiskFootprint;
  // Things the user must know or do outside the cluster first, one sentence
  // each: "Every node needs open-iscsi installed."
  prerequisites: string[];
  // What to know when an upgrade crosses a version, oldest first. Shown in
  // the upgrade preview (UpgradeCandidate.notes).
  upgradeNotes?: UpgradeNote[];
  // Its web UI has no sign-in of its own: anyone who reaches the URL can
  // use it (Longhorn).
  noLogin?: boolean;
  // How the console's sign-in gate treats it (deploy.ts, "Sign-in gate").
  // Absent: gated; only people signed in to the console reach it.
  // "credentials": gated for browsers, but a request carrying its own
  //   Authorization header goes straight to the app, which checks it (git
  //   over HTTPS, API and phone clients). Only for apps with a login of
  //   their own, never with noLogin.
  // "public": never gated, because people sign in through it (an identity
  //   provider): gating it would lock everyone out of the console too.
  gate?: "credentials" | "public";
}

// Rough, in bytes, from the pinned version's defaults.
export interface DiskFootprint {
  // Sum of the PersistentVolumeClaims a default install requests.
  volumeBytes: number;
  // Container images it pulls, as unpacked on a node.
  imageBytes: number;
}

export type DetectState = "installed" | "not-installed" | "unknown";

export interface DetectedApp {
  appId: string;
  state: DetectState;
  namespace?: string;
  // Helm release name, when the objects carry Helm's labels.
  release?: string;
  version?: string;
  // The chart version from Helm's helm.sh/chart label ("gitea-12.7.0" ->
  // "12.7.0"), when its objects carry one.
  chartVersion?: string;
  // URLs from its Ingresses, https first.
  urls: string[];
  // What the judgement was made on: "Deployment longhorn-system/longhorn-ui
  // (app.kubernetes.io/name=longhorn-ui)", or why it is unknown.
  evidence: string;
  managedBy: ManagedBy | null;
  // Installed by this product's deploy runner (carries its owner label).
  ownedByUs: boolean;
}

export interface CatalogAppView extends CatalogEntry {
  detected: DetectedApp;
}

export interface IngressHost {
  host: string;
  // https:// when the Ingress has a TLS entry for the host, else http://.
  url: string;
  tls: boolean;
  namespace: string;
  ingress: string;
  // The backend Service of the first rule for this host.
  service?: string;
  // That Service as the cluster reaches it, "http://<service>.<namespace>.svc:<port>",
  // when its port could be resolved to a number. The checks module probes it
  // when the host doesn't resolve.
  serviceUrl?: string;
  // spec.ingressClassName. "tailscale" marks a host that only resolves on the
  // tailnet; its `host` comes from the Ingress status (the full MagicDNS name).
  ingressClass?: string;
  // The catalog app this host belongs to, when discovery matched one.
  appId?: string;
  // Traefik middlewares from the Ingress's
  // traefik.ingress.kubernetes.io/router.middlewares annotation, as written
  // ("<namespace>-<name>@kubernetescrd"); absent when it has none.
  middlewares?: string[];
}

export type ClusterBasicId = "default-storage-class" | "ingress-controller" | "cert-manager" | "metrics-server";

export interface ClusterBasic {
  id: ClusterBasicId;
  label: string;
  // ok: present. warn: present but off (two default storage classes, an
  // ingress class nobody marked default). crit: missing.
  status: Status;
  detail: string;
  // Names of what was found: storage classes, ingress classes, issuers.
  found: string[];
  // Catalog apps that would fix it, best first; empty when the fix is not a
  // deploy (two defaults: pick one yourself).
  fixAppIds: string[];
}

export interface DiscoveryReport {
  checkedAt: string;
  // The API server's gitVersion ("v1.31.4+k3s1"); absent when it couldn't be read.
  kubernetesVersion?: string;
  apps: DetectedApp[];
  ingressHosts: IngressHost[];
  basics: ClusterBasic[];
  // Each node's free disk, from the kubelet's /stats/summary; absent when
  // the nodes couldn't be listed.
  nodeDisks?: NodeDisk[];
  // Defaults a deploy would use, from what was found; the deploy module's
  // settings override them.
  suggested: {
    storageClass?: string;
    ingressClass?: string;
    clusterIssuer?: string;
    // The domain most Ingress hosts share, for "<app>.<baseDomain>".
    baseDomain?: string;
    // The default ingress controller's Service as the cluster reaches it,
    // "http://traefik.kube-system.svc.cluster.local:80": the origin a tunnel
    // routes to.
    ingressService?: string;
    // The address it answers on from the network (its LoadBalancer IP or
    // hostname), for DNS records and hosts files.
    ingressAddress?: string;
  };
}

export interface NodeDisk {
  node: string;
  // The kubelet's root filesystem, where local-path and Longhorn keep volume
  // data by default. Absent when the node's stats couldn't be read.
  availableBytes?: number;
  capacityBytes?: number;
  // The container runtime's image filesystem. Usually the same disk, which
  // the kubelet reports with the same capacity.
  imageAvailableBytes?: number;
  imageCapacityBytes?: number;
  // Why the numbers are missing: "forbidden", "timeout", "node not ready".
  error?: string;
}

// A "Deploy bundle": a set of catalog apps rolled out in order from a few
// answers given once. How an app's inputs are filled, first match wins:
// the request's per-app value, the item's `bind` (app key <- shared key),
// a shared input with the same key, the item's literal `values`, the app's
// own default. An app's "host" defaults to "<hostPrefix ?? appId>.<baseDomain>".
// The shared "storageClass" (and the deploy module's defaults) set storage,
// ingress class and issuer as for a single deploy.
export interface BundleItem {
  appId: string;
  // Required items are always rolled out unless already installed; optional
  // ones can be left out (and some start unticked, see BundleItemView).
  required: boolean;
  // Host label for apps with a "host" input: "git" makes git.<baseDomain>.
  hostPrefix?: string;
  // App input key -> shared input key, where the names differ
  // (cert-manager's acmeEmail <- adminEmail).
  bind?: Record<string, string>;
  // App input key -> literal value.
  values?: Record<string, string | boolean>;
  // One sentence shown beside the item: why it is optional, what it needs.
  note?: string;
  // Part of the rollout only while a shared input matches (cloudflared only
  // for access "cloudflare-tunnel"); otherwise skipped like an item left out.
  // The bundle view doesn't know the answers, so the client evaluates it.
  when?: InputCondition;
}

export interface CatalogBundle {
  id: string;
  name: string;
  summary: string;
  // Install order: each item's requires come before it.
  items: BundleItem[];
  // Asked once: "access", "baseDomain", "adminEmail", "adminPassword",
  // "storageClass", and the access mode's own ("tunnelToken", ...).
  inputs: CatalogInput[];
}

export interface BundleItemView extends BundleItem {
  detected: DetectedApp;
  // Already installed, or its job already done (a default storage class
  // exists): the rollout skips it.
  skip: boolean;
  // Ticked by default: optional items are ticked unless a preflight the
  // catalog can run fails (the chart doesn't support this cluster's
  // Kubernetes); `reason` then says why. Prerequisites it can't check
  // (open-iscsi on the nodes) stay a `note`, not an untick.
  selected: boolean;
  // Why it is skipped or unticked, when it is.
  reason?: string;
}

export interface CatalogBundleView extends Omit<CatalogBundle, "items"> {
  items: BundleItemView[];
  // Discovery's suggestions, to prefill the shared "baseDomain" and "storageClass".
  suggested: { baseDomain?: string; storageClass?: string };
}

// Provided by module "catalog" as ctx.services.get("catalog").
export interface CatalogService {
  entries(): readonly CatalogEntry[];
  get(appId: string): CatalogEntry | undefined;
  // The Deploy bundles, the default one first.
  bundles(): readonly CatalogBundle[];
  // Cached for a short interval; refresh forces a new look.
  discover(refresh?: boolean): Promise<DiscoveryReport>;
}

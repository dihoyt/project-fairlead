// The app catalog and cluster discovery (module "catalog"). The catalog is
// fixed data in code: every app a first-timer can deploy from the wizard,
// with what it installs and how to tell it is already there. Discovery is
// read-only: it looks at the cluster and says which catalog apps are
// installed, which Ingress hosts exist, and which cluster basics are missing.
//
// Server-free on purpose: the client imports this file.

import type { Status } from "./health.js";
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
  // Things the user must know or do outside the cluster first, one sentence
  // each: "Every node needs open-iscsi installed."
  prerequisites: string[];
}

export type DetectState = "installed" | "not-installed" | "unknown";

export interface DetectedApp {
  appId: string;
  state: DetectState;
  namespace?: string;
  // Helm release name, when the objects carry Helm's labels.
  release?: string;
  version?: string;
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
  // The catalog app this host belongs to, when discovery matched one.
  appId?: string;
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
  apps: DetectedApp[];
  ingressHosts: IngressHost[];
  basics: ClusterBasic[];
  // Defaults a deploy would use, from what was found; the deploy module's
  // settings override them.
  suggested: {
    storageClass?: string;
    ingressClass?: string;
    clusterIssuer?: string;
    // The domain most Ingress hosts share, for "<app>.<baseDomain>".
    baseDomain?: string;
  };
}

// "Deploy bundle": the whole self-hosted set in one go, from a handful of
// answers given once. Items run in order; each app's own inputs are filled
// from the bundle's answers, literal defaults, and "<hostPrefix>.<baseDomain>"
// for its host. Storage, ingress class and issuer come from the deploy
// module's defaults, as for a single deploy.
export interface BundleItem {
  appId: string;
  // Required items are always part of the rollout; optional ones can be
  // unticked (and some start unticked, see BundleItemView.selected).
  required: boolean;
  // Host label for apps with a "host" input: "git" makes git.<baseDomain>.
  hostPrefix?: string;
  // App input key -> bundle input key it takes its value from.
  bind: Record<string, string>;
  // App input key -> literal value.
  values: Record<string, string | boolean>;
  // One sentence shown beside the item: why it is optional, what it needs.
  note?: string;
}

export interface CatalogBundle {
  id: string;
  name: string;
  summary: string;
  // Asked once for the whole bundle: "baseDomain", "adminEmail", "adminPassword".
  inputs: CatalogInput[];
  items: BundleItem[];
}

export interface BundleItemView extends BundleItem {
  detected: DetectedApp;
  // Already installed (or its job already done, like a default storage
  // class): the rollout skips it.
  skip: boolean;
  // Ticked by default: required items and optional ones whose
  // prerequisites cannot be checked from here start unticked.
  selected: boolean;
  // Why it is skipped or unticked, when it is.
  reason?: string;
}

export interface CatalogBundleView extends Omit<CatalogBundle, "items"> {
  items: BundleItemView[];
  // Discovery's suggestion for baseDomain, to prefill the one question
  // that matters most.
  suggestedBaseDomain?: string;
}

// Provided by module "catalog" as ctx.services.get("catalog").
export interface CatalogService {
  entries(): readonly CatalogEntry[];
  get(appId: string): CatalogEntry | undefined;
  // The "Deploy bundle" definition, ordered so each item's requires come first.
  bundle(): CatalogBundle;
  // Cached for a short interval; refresh forces a new look.
  discover(refresh?: boolean): Promise<DiscoveryReport>;
}

import type {
  BundleItemView,
  CatalogBundle,
  CatalogBundleView,
  ClusterBasicId,
  DiscoveryReport,
} from "../../contracts/catalog.js";

// The default bundle: what a first-timer's self-hosted cluster needs, in an
// order where every app's requires are already in place.
export const bundles: readonly CatalogBundle[] = [
  {
    id: "self-hosted",
    name: "Deploy bundle",
    summary: "Sets up the whole self-hosted toolkit with sensible defaults: sign-in, Git and phone alerts.",
    inputs: [
      {
        key: "baseDomain",
        label: "Base domain",
        help: "Apps get names under it, like git.example.com. Point a wildcard DNS record for it at your ingress.",
        kind: "text",
        required: true,
      },
      {
        key: "adminEmail",
        label: "Admin email",
        help: "Used for the first admin accounts and for Let's Encrypt.",
        kind: "text",
        required: true,
      },
      {
        key: "adminPassword",
        label: "Admin password",
        help: "The first password for every app that asks for one. Change it in each app afterwards.",
        kind: "secret",
        required: true,
      },
      {
        key: "storageClass",
        label: "Storage class",
        help: "Where apps keep their data. Leave empty for the cluster's default.",
        kind: "text",
        required: false,
      },
    ],
    items: [
      { appId: "traefik", required: true },
      { appId: "cert-manager", required: true, bind: { acmeEmail: "adminEmail" } },
      { appId: "metrics-server", required: true },
      { appId: "local-path-provisioner", required: true, values: { makeDefault: true } },
      {
        appId: "longhorn",
        required: false,
        note: "Every node needs open-iscsi installed first; tick it once yours do.",
      },
      { appId: "authentik", required: true, hostPrefix: "auth" },
      { appId: "gitea", required: true, hostPrefix: "git", values: { adminUser: "gitea-admin" } },
      { appId: "ntfy", required: true },
    ],
  },
];

// Apps whose job is a cluster basic: when the basic is already met by
// something else (k3s's own Traefik, a NAS storage class), the bundle
// leaves them out.
const basicFor: Record<string, ClusterBasicId> = {
  traefik: "ingress-controller",
  "cert-manager": "cert-manager",
  "local-path-provisioner": "default-storage-class",
  "metrics-server": "metrics-server",
};

export function bundleView(bundle: CatalogBundle, report: DiscoveryReport): CatalogBundleView {
  const items = bundle.items.map((item): BundleItemView => {
    const detected = report.apps.find((app) => app.appId === item.appId)!;
    const basic = report.basics.find((b) => b.id === basicFor[item.appId]);
    let reason: string | undefined;
    if (detected.state === "installed") reason = "Already installed";
    else if (basic && (basic.status === "ok" || basic.status === "warn")) reason = `Already covered: ${basic.detail}`;
    const skip = reason !== undefined;
    const selected = !skip && (item.required || !item.note);
    if (!skip && !selected) reason = item.note;
    return { ...structuredClone(item), detected, skip, selected, ...(reason ? { reason } : {}) };
  });
  const { baseDomain, storageClass } = report.suggested;
  return {
    id: bundle.id,
    name: bundle.name,
    summary: bundle.summary,
    inputs: structuredClone(bundle.inputs),
    items,
    suggested: { ...(baseDomain ? { baseDomain } : {}), ...(storageClass ? { storageClass } : {}) },
  };
}

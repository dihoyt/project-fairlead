import type {
  BundleItemView,
  CatalogBundle,
  CatalogBundleView,
  CatalogEntry,
  ClusterBasicId,
  DiscoveryReport,
} from "../../contracts/catalog.js";
import { pickVersion } from "../../contracts/kubeversion.js";

// The default bundle: what a first-timer's self-hosted cluster needs, in an
// order where every app's requires are already in place.
export const bundles: readonly CatalogBundle[] = [
  {
    id: "self-hosted",
    name: "Deploy bundle",
    summary: "Sets up the whole self-hosted toolkit with sensible defaults: sign-in, Git and phone alerts.",
    inputs: [
      {
        key: "access",
        label: "How you reach the apps",
        help: "Decides how every app is published, so it comes first. You can change it later under Setup.",
        kind: "select",
        required: true,
        options: [
          { value: "cloudflare-tunnel", label: "Cloudflare Tunnel: from anywhere, no open ports" },
          { value: "tailscale", label: "Tailscale: from your own devices only" },
          { value: "local", label: "Local network only" },
          { value: "direct", label: "Direct: ports 80 and 443 forwarded to the cluster" },
        ],
      },
      {
        key: "baseDomain",
        label: "Base domain",
        help: "Apps get names under it, like git.example.com. With Tailscale, your tailnet's DNS name, like tail1234.ts.net.",
        kind: "text",
        required: true,
      },
      {
        key: "cloudflareSetup",
        label: "How the tunnel is set up",
        help: "With an API token the Cloudflare connector creates the tunnel, runs cloudflared and adds every app's DNS record and route. With a tunnel token you add the routes yourself.",
        kind: "select",
        required: true,
        default: "token",
        options: [
          { value: "api", label: "Connect with an API token" },
          { value: "token", label: "Paste a tunnel token" },
        ],
        when: { input: "access", in: ["cloudflare-tunnel"] },
      },
      {
        key: "tunnelToken",
        label: "Cloudflare tunnel token",
        help: "In Cloudflare Zero Trust, Networks > Tunnels > Create a tunnel (Cloudflared), then copy the token from the install command.",
        kind: "secret",
        required: true,
        when: { input: "cloudflareSetup", in: ["token"] },
      },
      {
        key: "tailscaleClientId",
        label: "Tailscale OAuth client ID",
        help: "Tailscale admin console > Settings > OAuth clients, with Devices Core and Auth Keys write scopes and tag:k8s-operator.",
        kind: "text",
        required: true,
        when: { input: "access", in: ["tailscale"] },
      },
      {
        key: "tailscaleClientSecret",
        label: "Tailscale OAuth client secret",
        kind: "secret",
        required: true,
        when: { input: "access", in: ["tailscale"] },
      },
      {
        key: "signIn",
        label: "Sign-in service",
        help: "One login for the console and your apps. Pocket ID is lighter but passkey-only, so it needs https: Cloudflare Tunnel, Tailscale, or Direct with a certificate.",
        kind: "select",
        required: true,
        default: "authentik",
        options: [
          { value: "authentik", label: "Authentik: passwords, two-factor and passkeys" },
          { value: "pocket-id", label: "Pocket ID: passkeys only, a fraction of the memory" },
        ],
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
      // With the connector, cloudflared is its to run: the tunnel token never leaves the server.
      { appId: "cloudflared", required: true, when: { input: "cloudflareSetup", in: ["token"] } },
      {
        appId: "tailscale-operator",
        required: true,
        bind: { clientId: "tailscaleClientId", clientSecret: "tailscaleClientSecret" },
        when: { input: "access", in: ["tailscale"] },
      },
      { appId: "traefik", required: true },
      { appId: "cert-manager", required: true, bind: { acmeEmail: "adminEmail" } },
      { appId: "metrics-server", required: true },
      { appId: "local-path-provisioner", required: true, values: { makeDefault: true } },
      {
        appId: "longhorn",
        required: false,
        note: "Every node needs open-iscsi installed; untick it if yours don't have it.",
      },
      { appId: "authentik", required: true, hostPrefix: "auth", when: { input: "signIn", in: ["authentik"] } },
      { appId: "pocket-id", required: true, hostPrefix: "auth", when: { input: "signIn", in: ["pocket-id"] } },
      { appId: "gitea", required: true, hostPrefix: "git", values: { adminUser: "gitea-admin" } },
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

// Why an optional item starts unticked: a preflight that fails on this
// cluster. Prerequisites that can't be checked from here stay its note.
function preflight(entry: CatalogEntry | undefined, report: DiscoveryReport): string | undefined {
  if (!entry || entry.install.kind === "patch") return undefined;
  const picked = pickVersion(entry.install, report.kubernetesVersion);
  return picked.ok ? undefined : picked.reason;
}

export function bundleView(
  bundle: CatalogBundle,
  report: DiscoveryReport,
  entries: readonly CatalogEntry[]
): CatalogBundleView {
  const items = bundle.items.map((item): BundleItemView => {
    const detected = report.apps.find((app) => app.appId === item.appId)!;
    const basic = report.basics.find((b) => b.id === basicFor[item.appId]);
    let reason: string | undefined;
    if (detected.state === "installed") reason = "Already installed";
    else if (basic && (basic.status === "ok" || basic.status === "warn")) reason = `Already covered: ${basic.detail}`;
    const skip = reason !== undefined;
    const failed =
      skip || item.required
        ? undefined
        : preflight(
            entries.find((e) => e.id === item.appId),
            report
          );
    const selected = !skip && !failed;
    if (failed) reason = failed;
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

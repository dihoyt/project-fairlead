// How each catalog app is recognised in a cluster. Labels are the strong
// signal; an image match catches installs made from plain manifests or by
// tools that drop the recommended labels. Images are compared without
// registry and tag, so a mirror ("rancher/mirrored-...") needs its own entry.
export interface Signature {
  // Values of app.kubernetes.io/name, or the older `app` label.
  names: string[];
  // Chart names as they appear in helm.sh/chart, without the version.
  charts: string[];
  // Image repositories without registry or tag: "grafana/grafana".
  images: string[];
}

export const signatures: Record<string, Signature> = {
  "cert-manager": {
    names: ["cert-manager"],
    charts: ["cert-manager"],
    images: ["jetstack/cert-manager-controller"],
  },
  traefik: {
    names: ["traefik"],
    charts: ["traefik"],
    images: ["traefik", "rancher/mirrored-library-traefik"],
  },
  "metrics-server": {
    names: ["metrics-server"],
    charts: ["metrics-server"],
    images: ["metrics-server/metrics-server", "rancher/mirrored-metrics-server"],
  },
  "local-path-provisioner": {
    names: ["local-path-provisioner"],
    charts: ["local-path-provisioner"],
    images: ["rancher/local-path-provisioner", "rancher/mirrored-local-path-provisioner"],
  },
  longhorn: {
    names: ["longhorn", "longhorn-ui", "longhorn-manager"],
    charts: ["longhorn"],
    images: ["longhornio/longhorn-ui", "longhornio/longhorn-manager"],
  },
  rancher: {
    names: ["rancher"],
    charts: ["rancher"],
    images: ["rancher/rancher"],
  },
  headlamp: {
    names: ["headlamp"],
    charts: ["headlamp"],
    images: ["headlamp-k8s/headlamp", "kinvolk/headlamp"],
  },
  gitea: {
    names: ["gitea"],
    charts: ["gitea"],
    images: ["gitea/gitea", "gitea"],
  },
  grafana: {
    names: ["grafana"],
    charts: ["grafana"],
    images: ["grafana/grafana", "grafana/grafana-oss", "grafana/grafana-enterprise"],
  },
  authentik: {
    names: ["authentik"],
    charts: ["authentik"],
    images: ["goauthentik/server"],
  },
  "pocket-id": {
    names: ["pocket-id"],
    charts: ["pocket-id"],
    images: ["pocket-id/pocket-id", "stonith404/pocket-id"],
  },
  velero: {
    names: ["velero"],
    charts: ["velero"],
    images: ["velero/velero"],
  },
  ntfy: {
    names: ["ntfy"],
    charts: ["ntfy"],
    images: ["binwiederhier/ntfy"],
  },
  cloudflared: {
    names: ["cloudflared", "cloudflare-tunnel", "cloudflare-tunnel-remote"],
    charts: ["cloudflare-tunnel", "cloudflare-tunnel-remote"],
    images: ["cloudflare/cloudflared"],
  },
  "tailscale-operator": {
    names: ["tailscale-operator"],
    charts: ["tailscale-operator"],
    images: ["tailscale/k8s-operator"],
  },
};

// "docker.io/library/traefik:v3@sha256:..." -> { repo: "traefik", tag: "v3" }.
export function parseImage(image: string): { repo: string; tag?: string } {
  const at = image.indexOf("@");
  const ref = at >= 0 ? image.slice(0, at) : image;
  const parts = ref.split("/");
  if (parts.length > 1 && (/[.:]/.test(parts[0]!) || parts[0] === "localhost")) parts.shift();
  const last = parts.pop() ?? "";
  const colon = last.indexOf(":");
  const name = colon >= 0 ? last.slice(0, colon) : last;
  const tag = colon >= 0 ? last.slice(colon + 1) : undefined;
  let repo = [...parts, name].join("/");
  if (repo.startsWith("library/")) repo = repo.slice("library/".length);
  return tag ? { repo, tag } : { repo };
}

// "cert-manager-v1.21.1" -> "cert-manager"; "traefik-40.1.3_up40.1.0" -> "traefik".
export function chartName(label: string): string {
  return /^(.+?)-v?\d+\.\d+/.exec(label)?.[1] ?? label;
}

// "gitea-12.7.0" -> "12.7.0", "cert-manager-v1.18.2" -> "v1.18.2".
export function chartVersion(label: string | undefined): string | undefined {
  return label ? /^.+?-(v?\d+\.\d+\S*)$/.exec(label)?.[1] : undefined;
}

import type { CatalogEntry } from "../../contracts/catalog.js";
import { deployedLabel } from "../../contracts/deployed.js";
import { VALUES_DIR, ingressAnnotations, type RecipeInput, type Step } from "./apps.js";
import type { YamlValue } from "./yaml.js";

// Manifests go to the API server only at install time: a server-side dry
// run of a fresh manifest fails on its own not-yet-created namespace.
const DRY_RUN = "--dry-run=client";

export interface ServiceRef {
  name: string;
  namespace?: string;
  port: number;
}

// The first Service in a bundled manifest and its first port, read from
// the catalog's own YAML (block style, as the catalog writes it). A bundled
// manifest carries no Ingress, so this is where one for the host points.
export function firstService(manifest: string): ServiceRef | undefined {
  for (const doc of manifest.split(/^---\s*$/m)) {
    if (!/^kind:\s*Service\s*$/m.test(doc)) continue;
    const metadata = /^metadata:\s*\n((?:[ \t]+.*\n?)*)/m.exec(doc)?.[1] ?? "";
    const name = /^[ \t]{2}name:\s*["']?([a-z0-9.-]+)["']?\s*$/m.exec(metadata)?.[1];
    const namespace = /^[ \t]{2}namespace:\s*["']?([a-z0-9-]+)["']?\s*$/m.exec(metadata)?.[1];
    const port = /^\s*(?:-\s+)?port:\s*(\d+)\s*$/m.exec(doc.slice(doc.search(/^spec:/m)))?.[1];
    if (name && port) return { name, port: Number(port), ...(namespace ? { namespace } : {}) };
  }
  return undefined;
}

// Every Deployment in a bundled manifest, so the install waits for each
// to roll out instead of counting a successful apply as done.
export function deployments(manifest: string): { name: string; namespace?: string }[] {
  const found: { name: string; namespace?: string }[] = [];
  for (const doc of manifest.split(/^---\s*$/m)) {
    if (!/^kind:\s*Deployment\s*$/m.test(doc)) continue;
    const metadata = /^metadata:\s*\n((?:[ \t]+.*\n?)*)/m.exec(doc)?.[1] ?? "";
    const name = /^[ \t]{2}name:\s*["']?([a-z0-9.-]+)["']?\s*$/m.exec(metadata)?.[1];
    const namespace = /^[ \t]{2}namespace:\s*["']?([a-z0-9-]+)["']?\s*$/m.exec(metadata)?.[1];
    if (name) found.push({ name, ...(namespace ? { namespace } : {}) });
  }
  return found;
}

export const ROLLOUT_TIMEOUT = "5m";

export const TAILSCALE_CLASS = "tailscale";

// The Tailscale operator takes the node's name from the first label of the
// first TLS host and serves only host-less rules, over HTTPS with its own
// certificate.
export function ingressFor(r: RecipeInput, service: ServiceRef): YamlValue {
  const tailscale = r.defaults.access === "tailscale";
  const paths = [
    {
      path: "/",
      pathType: "Prefix",
      backend: { service: { name: service.name, port: { number: service.port } } },
    },
  ];
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: r.release,
      namespace: service.namespace ?? r.namespace,
      labels: deployedLabel(),
      annotations: ingressAnnotations(r),
    },
    spec: tailscale
      ? {
          ingressClassName: TAILSCALE_CLASS,
          rules: [{ http: { paths } }],
          tls: [{ hosts: [(r.host ?? r.release).split(".")[0]!] }],
        }
      : {
          ingressClassName: r.defaults.ingressClass,
          rules: [{ host: r.host, http: { paths } }],
          tls: r.tls ? [{ hosts: [r.host], secretName: `${r.release}-tls` }] : [],
        },
  };
}

export interface ManifestParts {
  steps: Step[];
  // Files beside the manifest in the values Secret (YAML values), by name.
  files: Record<string, YamlValue>;
  // The bundled manifest itself, written as is.
  raw: Record<string, string>;
  error?: string;
}

export function manifestParts(entry: CatalogEntry, r: RecipeInput): ManifestParts {
  const install = entry.install;
  if (install.kind !== "manifest") return { steps: [], files: {}, raw: {} };
  if (install.url && !install.bundled) {
    return { steps: [{ argv: ["kubectl", "apply", "-f", install.url], dryRun: DRY_RUN }], files: {}, raw: {} };
  }
  if (!install.bundled || install.url) {
    return {
      steps: [],
      files: {},
      raw: {},
      error: `The catalog entry for ${entry.name} has no single manifest source.`,
    };
  }
  const steps: Step[] = [{ argv: ["kubectl", "apply", "-f", `${VALUES_DIR}/manifest.yaml`], dryRun: DRY_RUN }];
  const raw = { "manifest.yaml": install.bundled };
  // No dryRun: skipped in a dry run, where nothing was created to wait on.
  const rollouts: Step[] = deployments(install.bundled).map((d) => ({
    argv: [
      "kubectl",
      "rollout",
      "status",
      `deployment/${d.name}`,
      "--namespace",
      d.namespace ?? r.namespace,
      `--timeout=${ROLLOUT_TIMEOUT}`,
    ],
  }));
  if (!entry.exposesUi || !r.host) return { steps: [...steps, ...rollouts], files: {}, raw };
  const service = firstService(install.bundled);
  if (!service) {
    return { steps, files: {}, raw, error: `The bundled manifest for ${entry.name} has no Service for its hostname.` };
  }
  steps.push({ argv: ["kubectl", "apply", "-f", `${VALUES_DIR}/ingress.yaml`], dryRun: DRY_RUN }, ...rollouts);
  return { steps, files: { "ingress.yaml": ingressFor(r, service) }, raw };
}

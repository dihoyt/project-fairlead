import type { Database } from "better-sqlite3";
import type { CatalogEntry, DiscoveryReport, IngressHost } from "../../contracts/catalog.js";
import type { AppGateState, AppGateView, DeployedRelease, GateStatus } from "../../contracts/deploy.js";
import {
  GATE_EMAIL_HEADER,
  GATE_FORWARD_PATH,
  GATE_USER_HEADER,
  type GateReadiness,
} from "../../contracts/platform.js";
import { deployedLabel } from "../../contracts/deployed.js";
import { product } from "../../product.js";
import type { KubeObject } from "../../contracts/k8s.js";
import type { Defaults, Step } from "./apps.js";
import { TAILSCALE_CLASS } from "./manifest.js";
import { toYaml, type YamlValue } from "./yaml.js";

// The sign-in gate as the deploy runner applies it: one Traefik Middleware
// per kind in this product's namespace, pointing forwardAuth at its
// Service, referenced from each gated app's Ingresses through Traefik's
// middlewares annotation.

export const MIDDLEWARES_ANNOTATION = "traefik.ingress.kubernetes.io/router.middlewares";
const BASE = `${product.ownerMarker.externalPrefix}gate`;
const CREDENTIALS = `${BASE}-credentials`;
const DNS_NAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

// Where the console is, as Traefik reaches it: the chart's Service, named
// after the release, on port 80.
export interface ConsoleRef {
  namespace: string;
  service: string;
}

// The console's own public host, which every gated app sends people to.
export interface ConsoleHost {
  host: string;
  // The gate writes the console's Ingress for it (see consoleIngress).
  publish: boolean;
  // A lookup from the pod; undefined where that says nothing (hosts-file
  // names in local mode).
  resolves?: boolean;
}

export interface GateInput {
  console: ConsoleRef;
  readiness: GateReadiness;
  consoleHost?: ConsoleHost;
}

export const middlewareName = (credentials: boolean) => (credentials ? CREDENTIALS : BASE);
export const middlewareRef = (namespace: string, name: string) => `${namespace}-${name}@kubernetescrd`;

// Ours in any namespace, so a gate written from an earlier install's
// namespace is still recognised (and replaced).
export function isGateRef(ref: string): boolean {
  return ref.endsWith(`-${BASE}@kubernetescrd`) || ref.endsWith(`-${CREDENTIALS}@kubernetescrd`);
}

export const isTraefik = (ingressClass: string | undefined) => Boolean(ingressClass && /traefik/.test(ingressClass));

// Behind a tunnel Traefik sees plain http while people use https.
export function proto(defaults: Defaults): "https" | "http" {
  const access = defaults.access ?? "direct";
  return access === "cloudflare-tunnel" || (access === "direct" && Boolean(defaults.clusterIssuer)) ? "https" : "http";
}

export function middlewareManifest(input: GateInput, defaults: Defaults, credentials: boolean): YamlValue {
  const query = new URLSearchParams({ proto: proto(defaults), ...(credentials ? { credentials: "1" } : {}) });
  const { namespace, service } = input.console;
  return {
    apiVersion: "traefik.io/v1alpha1",
    kind: "Middleware",
    metadata: { name: middlewareName(credentials), namespace },
    spec: {
      forwardAuth: {
        address: `http://${service}.${namespace}.svc.cluster.local${GATE_FORWARD_PATH}?${query.toString()}`,
        trustForwardHeader: false,
        authResponseHeaders: [GATE_USER_HEADER, GATE_EMAIL_HEADER],
      },
    },
  };
}

export const MIDDLEWARE_FILE = "gate-middleware.yaml";
export const CONSOLE_INGRESS = `${product.ownerMarker.externalPrefix}console`;

const PUBLISHED_MODES = new Set(["cloudflare-tunnel", "direct", "local"]);
const IP = /^[\d.]+$|:/;

export function hostOf(url: string): string | undefined {
  try {
    return url ? new URL(url).hostname : undefined;
  } catch {
    return undefined;
  }
}

// Whether the gate writes an Ingress for the console's own host: a name under
// the Access base domain, in a mode that routes that domain through the
// ingress controller, that no Ingress other than the gate's already serves.
// The console otherwise listens only on its Service, and a gated app would
// send people to a name nothing answers.
export function publishesConsole(
  host: string,
  defaults: Defaults,
  ref: ConsoleRef,
  hosts: readonly IngressHost[],
  objects?: readonly KubeObject[]
): boolean {
  const domain = defaults.baseDomain;
  if (!domain || IP.test(host) || !host.endsWith(`.${domain}`)) return false;
  if (!PUBLISHED_MODES.has(defaults.access ?? "direct") || !isTraefik(defaults.ingressClass)) return false;
  const ours = (namespace: string | undefined, name: string | undefined) =>
    namespace === ref.namespace && name === CONSOLE_INGRESS;
  if (objects) {
    return !(objects as readonly IngressObject[]).some(
      (obj) => !ours(obj.metadata.namespace, obj.metadata.name) && (obj.spec?.rules ?? []).some((r) => r.host === host)
    );
  }
  return !hosts.some((h) => h.host === host && !ours(h.namespace, h.ingress));
}

export function consoleIngress(input: GateInput, defaults: Defaults, host: string): YamlValue {
  const tls = (defaults.access ?? "direct") === "direct" && Boolean(defaults.clusterIssuer);
  const { namespace, service } = input.console;
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: CONSOLE_INGRESS,
      namespace,
      labels: deployedLabel(),
      annotations: tls ? { "cert-manager.io/cluster-issuer": defaults.clusterIssuer! } : {},
    },
    spec: {
      ingressClassName: defaults.ingressClass,
      rules: [
        {
          host,
          http: {
            paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: service, port: { number: 80 } } } }],
          },
        },
      ],
      tls: tls ? [{ hosts: [host], secretName: `${CONSOLE_INGRESS}-tls` }] : [],
    },
  };
}

// What MIDDLEWARE_FILE holds: the Middleware, then the console's Ingress
// when the gate publishes it.
export function gateManifests(input: GateInput, defaults: Defaults, credentials: boolean): string {
  const docs = [toYaml(middlewareManifest(input, defaults, credentials))];
  const c = input.consoleHost;
  if (c?.publish) docs.push(toYaml(consoleIngress(input, defaults, c.host)));
  return docs.join("---\n");
}

// Said wherever the gate is about to be applied while the console's host
// doesn't resolve yet but the gate is publishing it.
export function consoleWarning(input: GateInput): string | undefined {
  const c = input.consoleHost;
  if (!c?.publish || c.resolves !== false) return undefined;
  return `${c.host} doesn't resolve yet. This publishes the console there; until a DNS record points it at the cluster (the Cloudflare connector adds one on its next sync), signing in to a gated app lands on a page that doesn't answer.`;
}

export interface GateDecision {
  state: AppGateState;
  reason?: string;
  // Set when gated: the reference its Ingresses carry.
  middleware?: string;
  credentials: boolean;
}

// Why the gate can't be put in front of apps right now, or undefined.
export function unavailable(defaults: Defaults, input: GateInput): string | undefined {
  if (!isTraefik(defaults.ingressClass)) {
    return defaults.ingressClass
      ? `The ingress class ${defaults.ingressClass} isn't Traefik's, so the console's sign-in can't be put in front of apps.`
      : "No ingress class found, so the console's sign-in can't be put in front of apps.";
  }
  if (!input.readiness.ready) return input.readiness.reason;
  const c = input.consoleHost;
  if (c && !c.publish && c.resolves === false) {
    return `The console's address ${c.host} doesn't resolve, so signing in to a gated app would land on a page that doesn't answer. Give ${c.host} a DNS record (or set the console's public URL to a name under the Access step's base domain, which the gate publishes), then try again.`;
  }
  return undefined;
}

export function decide(entry: CatalogEntry, defaults: Defaults, isPublic: boolean, input: GateInput): GateDecision {
  const credentials = entry.gate === "credentials";
  if (defaults.access === "tailscale") return { state: "tailnet", credentials };
  if (entry.gate === "public") {
    return { state: "public", reason: `${entry.name} has to be reachable without the console's sign-in.`, credentials };
  }
  if (isPublic) return { state: "public", credentials };
  const why = unavailable(defaults, input);
  if (why) return { state: "open", reason: why, credentials };
  return {
    state: "gated",
    middleware: middlewareRef(input.console.namespace, middlewareName(credentials)),
    credentials,
  };
}

export function gateWarning(entry: CatalogEntry, decision: GateDecision): string | undefined {
  if (decision.state === "open") return `Anyone with its address can open ${entry.name}: ${decision.reason}`;
  if (decision.state === "public" && entry.gate !== "public" && entry.noLogin) {
    return `${entry.name} is public and has no sign-in of its own: anyone with its address can use it.`;
  }
  return undefined;
}

// --- Ingresses in place ------------------------------------------------------

export interface AppIngress {
  namespace: string;
  name: string;
  // Its middlewares as discovery read them.
  middlewares: string[];
}

interface IngressObject extends KubeObject {
  spec?: { ingressClassName?: string; rules?: Array<{ host?: string }> };
}

const middlewaresOf = (obj: KubeObject): string[] =>
  (obj.metadata.annotations?.[MIDDLEWARES_ANNOTATION] ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

// Every Ingress serving one of the app's hosts, Tailscale's left out. Read
// from the Ingresses themselves when given: discovery keeps one Ingress per
// host, and a TLS-only Ingress beside the app's own (Direct exposure)
// serves the same host and needs the gate as much.
export function appIngresses(
  hosts: readonly IngressHost[],
  appId: string,
  objects?: readonly KubeObject[]
): AppIngress[] {
  const names = new Set(
    hosts.filter((h) => h.appId === appId && h.ingressClass !== TAILSCALE_CLASS).map((h) => h.host)
  );
  const found = new Map<string, AppIngress>();
  if (objects) {
    for (const obj of objects as readonly IngressObject[]) {
      if (obj.spec?.ingressClassName === TAILSCALE_CLASS) continue;
      if (!(obj.spec?.rules ?? []).some((r) => r.host && names.has(r.host))) continue;
      const namespace = obj.metadata.namespace ?? "";
      found.set(`${namespace}/${obj.metadata.name}`, {
        namespace,
        name: obj.metadata.name,
        middlewares: middlewaresOf(obj),
      });
    }
  } else {
    for (const h of hosts) {
      if (h.ingressClass === TAILSCALE_CLASS || !names.has(h.host)) continue;
      found.set(`${h.namespace}/${h.ingress}`, {
        namespace: h.namespace,
        name: h.ingress,
        middlewares: h.middlewares ?? [],
      });
    }
  }
  return [...found.values()].toSorted((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));
}

// The annotation's new value: everything else it carried, then the gate.
export function withGate(middlewares: readonly string[], ref: string | undefined): string[] {
  return [...middlewares.filter((m) => !isGateRef(m)), ...(ref ? [ref] : [])];
}

// kubectl annotate for each Ingress whose middlewares change; names come
// from the cluster and must be DNS names.
export function annotateSteps(ingresses: readonly AppIngress[], ref: string | undefined): Step[] {
  const steps: Step[] = [];
  for (const ing of ingresses) {
    if (!DNS_NAME.test(ing.namespace) || !DNS_NAME.test(ing.name)) continue;
    const next = withGate(ing.middlewares, ref);
    if (next.join(",") === ing.middlewares.join(",")) continue;
    steps.push({
      argv: [
        "kubectl",
        "annotate",
        "ingress",
        ing.name,
        "--namespace",
        ing.namespace,
        next.length > 0 ? `${MIDDLEWARES_ANNOTATION}=${next.join(",")}` : `${MIDDLEWARES_ANNOTATION}-`,
        "--overwrite",
      ],
      dryRun: "--dry-run=server",
    });
  }
  return steps;
}

export const applyMiddlewareStep = (): Step => ({
  argv: ["kubectl", "apply", "-f", `/values/${MIDDLEWARE_FILE}`],
  dryRun: "--dry-run=server",
});

// --- The saved choice ----------------------------------------------------------

export class GateStore {
  private readonly db: Database;
  private readonly orgId: string;

  constructor(db: Database, orgId: string) {
    this.db = db;
    this.orgId = orgId;
  }

  isPublic(appId: string): boolean {
    const row = this.db
      .prepare("SELECT public FROM deploy_gate WHERE org_id = ? AND app_id = ?")
      .get(this.orgId, appId) as { public: number } | undefined;
    return row?.public === 1;
  }

  set(appId: string, isPublic: boolean, by: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO deploy_gate (org_id, app_id, public, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (org_id, app_id) DO UPDATE SET public = excluded.public,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      )
      .run(this.orgId, appId, isPublic ? 1 : 0, by, at);
  }
}

// --- What GET /api/deploy/gate answers -----------------------------------------

export function appView(
  entry: CatalogEntry,
  defaults: Defaults,
  isPublic: boolean,
  input: GateInput,
  hosts: readonly IngressHost[],
  objects?: readonly KubeObject[]
): AppGateView {
  const all = hosts.filter((h) => h.appId === entry.id);
  const decision = decide(entry, defaults, isPublic, input);
  const ingresses = appIngresses(hosts, entry.id, objects);
  const base = {
    appId: entry.id,
    name: entry.name,
    public: entry.gate === "public" || isPublic,
    ...(entry.gate ? { mode: entry.gate } : {}),
    hosts: [...new Set(all.map((h) => h.host))].toSorted(),
  };
  const tailnetOnly = all.length > 0 && all.every((h) => h.ingressClass === TAILSCALE_CLASS);
  if (decision.state === "tailnet" || tailnetOnly) return { ...base, state: "tailnet" };
  const bare = ingresses.filter((ing) => !ing.middlewares.some(isGateRef));
  if (decision.state === "public") {
    return { ...base, state: "public", ...(decision.reason ? { reason: decision.reason } : {}) };
  }
  if (ingresses.length > 0 && bare.length === 0) return { ...base, state: "gated" };
  const reason =
    decision.state === "open"
      ? decision.reason!
      : `${bare.map((ing) => `${ing.namespace}/${ing.name}`).join(", ")} ${bare.length === 1 ? "has" : "have"} no gate; turn Public off again to put it back.`;
  return { ...base, state: "open", reason };
}

export function gateStatus(
  entries: readonly CatalogEntry[],
  releases: readonly DeployedRelease[],
  discovery: DiscoveryReport | undefined,
  defaults: Defaults,
  input: GateInput,
  isPublic: (appId: string) => boolean,
  objects?: readonly KubeObject[]
): GateStatus {
  const why =
    defaults.access === "tailscale"
      ? "Apps are reached over Tailscale; the tailnet is the gate."
      : unavailable(defaults, input);
  const hosts = discovery?.ingressHosts ?? [];
  const apps: AppGateView[] = [];
  for (const release of releases) {
    const entry = entries.find((e) => e.id === release.appId);
    if (!entry?.exposesUi || release.state !== "succeeded") continue;
    if (!hosts.some((h) => h.appId === entry.id)) continue;
    apps.push(appView(entry, defaults, isPublic(entry.id), input, hosts, objects));
  }
  return {
    ready: why === undefined,
    ...(why ? { reason: why } : {}),
    ...(input.readiness.signInUrl ? { signInUrl: input.readiness.signInUrl } : {}),
    ...(why === undefined ? { middleware: middlewareRef(input.console.namespace, BASE) } : {}),
    apps: apps.toSorted((a, b) => a.name.localeCompare(b.name)),
  };
}

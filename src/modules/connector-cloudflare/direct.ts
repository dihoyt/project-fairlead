import type { CatalogEntry } from "../../contracts/catalog.js";
import type { CloudflareHostView, OwnedStore } from "../../contracts/connectors.js";
import type { DeployService } from "../../contracts/deploy.js";
import { RESOURCES, type K8sApi, type KubeObject } from "../../contracts/k8s.js";
import { specHash } from "./sync.js";

// Direct exposure's certificate: a TLS-only Ingress beside the app's own,
// written by the deploy runner (recipe "direct-tls") because this product's
// ServiceAccount can't write Ingresses. Recorded in OwnedStore so a host
// going back to the tunnel, or the connector's cleanup, removes it.

export const TLS = "k8s-direct-tls";
const RECIPE = "direct-tls";

interface IngressSpec {
  ingressClassName?: string;
  tls?: Array<{ hosts?: string[]; secretName?: string }>;
  rules?: Array<{
    host?: string;
    http?: { paths?: Array<{ backend?: { service?: { name?: string; port?: { number?: number; name?: string } } } }> };
  }>;
}

interface Backend {
  namespace: string;
  service: string;
  port: string;
  ingressClass?: string;
}

export interface DirectTlsInput {
  k8s: K8sApi;
  deploy: DeployService;
  owned: OwnedStore;
  prefix: string;
  issuer?: string;
  // Hosts set to direct, and every view to fill in.
  views: CloudflareHostView[];
}

export const tlsName = (prefix: string, host: string) =>
  `${prefix}direct-${host.split(".")[0]!.replace(/[^a-z0-9-]/g, "-")}`.slice(0, 63).replace(/-+$/, "");

const text = (key: string, required = true) => ({ key, label: key, kind: "text" as const, required });

// The catalog entry the deploy runner plans and runs; the recipe of the same
// id in the deploy module renders and applies it.
export function directTlsEntry(namespace: string): CatalogEntry {
  return {
    id: RECIPE,
    name: "Certificate for a direct app",
    summary: "Gets a certificate from cert-manager for an app reached straight at your public address.",
    slots: [],
    homepage: "https://cert-manager.io/",
    install: { kind: "patch", target: "networking.k8s.io Ingress (TLS)" },
    namespace,
    requires: [],
    inputs: [
      text("name"),
      { key: "domain", label: "domain", kind: "hostname", required: true },
      text("service"),
      text("port"),
      text("ingressClass", false),
      text("issuer"),
      { key: "remove", label: "remove", kind: "boolean", required: false, default: false },
    ],
    exposesUi: false,
    prerequisites: ["cert-manager with a ClusterIssuer."],
  };
}

function backendFor(host: string, prefix: string, ingresses: KubeObject[]): Backend | undefined {
  for (const ing of ingresses) {
    if (ing.metadata.name.startsWith(`${prefix}direct-`)) continue;
    const spec = (ing.spec ?? {}) as IngressSpec;
    const rule = spec.rules?.find((r) => r.host === host);
    const service = rule?.http?.paths?.[0]?.backend?.service;
    if (!service?.name || !service.port) continue;
    const port = service.port.number !== undefined ? String(service.port.number) : service.port.name;
    if (!port) continue;
    return {
      namespace: ing.metadata.namespace ?? "default",
      service: service.name,
      port,
      ...(spec.ingressClassName ? { ingressClass: spec.ingressClassName } : {}),
    };
  }
  return undefined;
}

type Run = (namespace: string, inputs: Record<string, string | boolean>) => Promise<"started" | "queued">;

interface TlsSpec {
  namespace: string;
  name: string;
  host: string;
  service: string;
  port: string;
  issuer: string;
}

const removeTls = (run: Run, spec: TlsSpec) =>
  run(spec.namespace, {
    name: spec.name,
    domain: spec.host,
    service: spec.service,
    port: spec.port,
    ingressClass: "",
    issuer: spec.issuer,
    remove: true,
  });

// For the connector's cleanup: removes the first recorded certificate
// Ingress and names the rest, which need a job each.
export async function removeAllTls(
  deploy: DeployService,
  owned: OwnedStore
): Promise<{ removed: number; errors: string[] }> {
  const rows = owned.list(TLS);
  const errors: string[] = [];
  let removed = 0;
  for (const [i, row] of rows.entries()) {
    const spec = row.spec as unknown as TlsSpec;
    if (i > 0) {
      errors.push(`Ingress ${spec.namespace}/${spec.name} stays; delete it with kubectl if you no longer need it`);
      continue;
    }
    try {
      const entry = directTlsEntry(spec.namespace);
      await removeTls(async (namespace, inputs) => {
        await deploy.startEntry("system", entry, { appId: entry.id, namespace, inputs, mode: "install" });
        return "started";
      }, spec);
      owned.delete(row.key, TLS);
      removed++;
    } catch (err) {
      errors.push(`Ingress ${spec.namespace}/${spec.name}: ${message(err)}`);
    }
  }
  return { removed, errors };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function ready(cert: KubeObject | null | "absent"): boolean {
  if (!cert || cert === "absent") return false;
  const conditions = (cert.status as { conditions?: Array<{ type: string; status: string }> } | undefined)?.conditions;
  return conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false;
}

// Starts at most one deploy job per call (the runner takes one job per
// release at a time); the deploy.finished that follows brings the next sync.
export async function directTls(input: DirectTlsInput): Promise<void> {
  const { k8s, deploy, owned, prefix, views } = input;
  let started = false;
  const run: Run = async (namespace, inputs) => {
    if (started) return "queued";
    const entry = directTlsEntry(namespace);
    await deploy.startEntry("system", entry, { appId: entry.id, namespace, inputs, mode: "install" });
    started = true;
    return "started";
  };

  const direct = views.filter((v) => v.exposure === "direct" && v.dns.state !== "conflict-unowned");
  const wanted = new Set(direct.map((v) => v.host));
  const listed = await k8s.list(RESOURCES.ingresses);
  const ingresses = listed === "absent" ? [] : listed;

  for (const view of direct) {
    const set = (status: CloudflareHostView["status"], detail: string) => {
      if (view.status === "ok" || (view.status === "warn" && status === "crit")) {
        view.status = status;
        view.detail = detail;
      }
    };
    if (!input.issuer) {
      set("warn", "No cert-manager ClusterIssuer was found, so the app can't get a certificate for direct traffic");
      continue;
    }
    const backend = backendFor(view.host, prefix, ingresses);
    if (!backend) {
      set("warn", `No Ingress serves ${view.host}, so there is nothing to put a certificate on`);
      continue;
    }
    const name = tlsName(prefix, view.host);
    const spec = { ...backend, host: view.host, issuer: input.issuer, name };
    const recorded = owned.get(view.host, TLS);
    const current = await k8s.get(RESOURCES.ingresses, name, backend.namespace).catch(() => null);
    if (!current || current === "absent" || recorded?.specHash !== specHash(spec)) {
      try {
        const how = await run(backend.namespace, {
          name,
          domain: view.host,
          service: backend.service,
          port: backend.port,
          ingressClass: backend.ingressClass ?? "",
          issuer: input.issuer,
          remove: false,
        });
        owned.put({ key: view.host, kind: TLS, spec, specHash: specHash(spec) });
        set("warn", how === "started" ? "Requesting a certificate from cert-manager" : "Certificate request queued");
      } catch (err) {
        set("warn", `The certificate can't be set up: ${message(err)}`);
      }
      continue;
    }
    const cert = await k8s.get(RESOURCES.certificates, `${name}-tls`, backend.namespace).catch(() => null);
    if (ready(cert)) set("ok", "Straight to your public address, with a certificate from cert-manager");
    else set("warn", "Waiting for cert-manager to issue the certificate");
  }

  for (const row of owned.list(TLS)) {
    if (wanted.has(row.key)) continue;
    const spec = row.spec as unknown as TlsSpec;
    try {
      if ((await removeTls(run, spec)) === "started") owned.delete(row.key, TLS);
    } catch {
      // Kept recorded: the next sync tries again.
    }
  }
}

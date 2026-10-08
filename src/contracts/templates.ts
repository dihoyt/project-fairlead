// App templates (module "templates"): small apps deployed from the Templates
// page. A starter library (whoami, Uptime Kuma, IT-Tools) and "Custom app",
// a template the user fills in. Every template renders to plain manifests
// (Namespace, Deployment, Service, and a PersistentVolumeClaim when it keeps
// data) in a namespace of its own, which the guardrail checks before
// anything runs. The templates module hands the result to the deploy runner
// as a CatalogEntry of its own making (install kind "manifest", bundled), so
// jobs, logs, the Ingress for the access mode, the Apps page and Upgrades
// treat a template instance like a catalog app.
//
// Server-free on purpose: the client imports this file.

import type { CatalogEntry, DiskFootprint } from "./catalog.js";
import type { DeployJobView, DeployMode, DeployPlan, WantedPort } from "./deploy.js";

// The template id of the Custom app form.
export const CUSTOM_TEMPLATE = "custom";

// The template id of the External service form: something running outside
// the cluster (a VM, a NAS, a game server) published through the cluster's
// Traefik. It renders no workload: a selector-less Service and an
// EndpointSlice at the address, plus, for TCP and UDP, a Traefik
// IngressRouteTCP or IngressRouteUDP on the entrypoint for its public port
// (traefikEntrypoint() in ./deploy.ts). HTTP and HTTPS get the deploy
// runner's Ingress like any template, so the access mode, the sign-in gate
// and the Cloudflare connector treat them like any app. TCP and UDP can't
// ride a Cloudflare tunnel (Spectrum is a paid plan): they are reached at
// the cluster's own address on the public port, through ports forwarded to
// it ("deploy.forwardedPorts").
export const EXTERNAL_TEMPLATE = "external";

// A namespace an instance runs in carries `<labelDomain>/app-template:
// <template id>` (plus the deployed-by label and Pod Security "baseline"
// enforcement). The chart's ValidatingAdmissionPolicy guards namespaces with
// a label ending in this suffix.
export const TEMPLATE_LABEL_SUFFIX = "app-template";

export interface AppTemplate {
  // "whoami", "uptime-kuma", "it-tools"; CUSTOM_TEMPLATE for the form.
  id: string;
  name: string;
  // The "What is this?" line.
  summary: string;
  homepage?: string;
  // Image without its tag, and the pinned tag. Both empty for the custom
  // template, where the user names the image.
  image: string;
  version: string;
  // The container port its web page is on; 0 for the custom template.
  port: number;
  // Where it keeps data and how much it asks for by default; absent when it
  // keeps none.
  volume?: { mountPath: string; size: string };
  disk?: DiskFootprint;
  // Its page has no sign-in of its own (CatalogEntry.noLogin).
  noLogin?: boolean;
}

export interface EnvVar {
  // A C identifier: [A-Za-z_][A-Za-z0-9_]*.
  name: string;
  // Stored and shown in plain text, like any Deployment env value.
  value: string;
}

export interface CustomAppSpec {
  // "ghcr.io/org/app:1.2.3" or "...@sha256:<digest>". A tag or digest is
  // required: an implicit "latest" would make every redeploy a different app.
  image: string;
  // The container port its web page or API is on, 1-65535.
  port: number;
  // At most 50.
  env: EnvVar[];
  // A volume mounted at mountPath (absolute, not "/").
  volume?: { size: string; mountPath: string };
}

// http, https: a web page or API, published on a hostname by the Ingress.
// https: the target speaks TLS itself (a NAS or hypervisor UI).
// tcp, udp: published on publicPort of the cluster's address.
export type ExternalProtocol = "http" | "https" | "tcp" | "udp";

export interface ExternalServiceSpec {
  // An IPv4 or IPv6 address outside the cluster, "10.0.0.50". Not a
  // hostname: an EndpointSlice holds addresses only.
  address: string;
  // The port the service listens on there, 1-65535.
  port: number;
  protocol: ExternalProtocol;
  // tcp and udp only: the port people connect to on the cluster's address,
  // one of the "deploy.forwardedPorts" range. Default: port. When it
  // differs from port, protocols that carry their own port inside their
  // messages (server browsers of some games, FTP, SIP) may only work when
  // the service is reached directly; the plan warns.
  publicPort?: number;
  // https only: accept the target's self-signed certificate. Default false.
  insecureSkipVerify?: boolean;
}

export interface TemplateDeployRequest {
  templateId: string;
  // The instance's name: its release, its namespace and the first label of
  // its default hostname. A DNS label (at most 40 characters) that is not a
  // catalog app id. Default: the template id; required for the custom
  // template.
  name?: string;
  // Omitted: "<name>.<base domain>" from the Access step. "": no Ingress,
  // reachable inside the cluster only.
  host?: string;
  // The volume's size ("5Gi") and storage class, for a template that keeps
  // data (the custom one when custom.volume is set). Storage class omitted:
  // the cluster's default.
  volumeSize?: string;
  storageClass?: string;
  // Required when templateId is CUSTOM_TEMPLATE, refused otherwise.
  custom?: CustomAppSpec;
  // Required when templateId is EXTERNAL_TEMPLATE, refused otherwise. host
  // applies to http and https only; volumeSize and storageClass are refused.
  external?: ExternalServiceSpec;
  // Passed on as DeployRequest.public: reachable without signing in to the
  // console. Default false.
  public?: boolean;
}

export interface TemplateJobRequest extends TemplateDeployRequest {
  mode: DeployMode;
}

// What the guardrail refuses in a rendered manifest:
// - privileged: a container with securityContext.privileged.
// - privilege-escalation: allowPrivilegeEscalation true.
// - capabilities: an added capability outside Pod Security "baseline"'s list.
// - host-path, host-network, host-pid, host-ipc, host-port: the node's own.
// - cluster-rbac: a ClusterRole or ClusterRoleBinding, a RoleBinding to the
//   cluster-admin, admin or edit ClusterRole, or a Role with "*" in its
//   verbs, resources or API groups.
// - kind: any other kind than Namespace, Deployment, Service,
//   PersistentVolumeClaim, ConfigMap, Secret, ServiceAccount, Role,
//   RoleBinding (for EXTERNAL_TEMPLATE also EndpointSlice, IngressRouteTCP,
//   IngressRouteUDP and ServersTransport), or an object outside the
//   instance's namespace.
export type GuardrailRule =
  | "privileged"
  | "privilege-escalation"
  | "capabilities"
  | "host-path"
  | "host-network"
  | "host-pid"
  | "host-ipc"
  | "host-port"
  | "cluster-rbac"
  | "kind";

export interface GuardrailViolation {
  rule: GuardrailRule;
  // "Deployment/whoami".
  object: string;
  // "spec.template.spec.volumes[0].hostPath".
  path: string;
  // One sentence.
  message: string;
}

export interface TemplatePlan {
  templateId: string;
  name: string;
  namespace: string;
  // False when the request has field errors, the guardrail found anything,
  // or the deploy runner's plan is not allowed; blockedBy says which.
  allowed: boolean;
  blockedBy?: string;
  // Field errors by request path: "name", "host", "custom.image",
  // "custom.env.2.name", "volumeSize".
  fieldErrors: Record<string, string>;
  violations: GuardrailViolation[];
  // The rendered manifests as YAML documents, shown before deploy. The
  // Ingress for the access mode is the deploy runner's, in deploy.values.
  manifests: string;
  // The deploy runner's plan for it: commands, Ingress, URL, warnings.
  // Absent when field errors stop the render.
  deploy?: DeployPlan;
  // EXTERNAL_TEMPLATE over tcp or udp: the Traefik entrypoint it needs and
  // whether Traefik serves it yet. When open is false the route is applied
  // anyway (Traefik ignores it until the entrypoint exists) and the
  // "traefik-ports" action opens it.
  entrypoint?: { name: string; port: number; protocol: "tcp" | "udp"; open: boolean };
}

export interface TemplateInstance {
  name: string;
  templateId: string;
  namespace: string;
  // The image tag it was last deployed with.
  version: string;
  // The library's pin, when newer than `version`: upgrade it from Upgrades
  // or by deploying it again.
  newerVersion?: string;
  // "" when deployed without an Ingress.
  host: string;
  url?: string;
  volumeSize?: string;
  storageClass?: string;
  // The custom template's spec, to prefill the form for a redeploy.
  custom?: CustomAppSpec;
  // The external service's spec, likewise.
  external?: ExternalServiceSpec;
  // Its latest deploy job, when the runner still has it.
  lastJob?: DeployJobView;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TemplatesView {
  // Library order, then the custom and external templates.
  templates: AppTemplate[];
  // Newest first.
  instances: TemplateInstance[];
}

// Provided by module "templates" as ctx.services.get("templates").
export interface TemplatesService {
  // One entry per saved instance (an install that started), at the
  // library's current pin with the instance's own answers, so the deploy
  // runner's upgrade report and upgrade jobs cover template instances. Each
  // id is the instance name.
  entries(): readonly CatalogEntry[];
  // The public ports external services over tcp and udp ask Traefik for,
  // by instance name, so the "traefik-ports" action opens exactly these.
  forwardedPorts(): readonly WantedPort[];
}

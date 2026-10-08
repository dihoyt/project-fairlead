import { isIP } from "node:net";
import { deployedLabel } from "../../contracts/deployed.js";
import {
  RESERVED_PORTS,
  traefikEntrypoint,
  type ForwardedProtocol,
  type PortsView,
  type WantedPort,
} from "../../contracts/deploy.js";
import type { KubeObject } from "../../contracts/k8s.js";
import { EXTERNAL_TEMPLATE, type AppTemplate, type ExternalServiceSpec } from "../../contracts/templates.js";
import { product } from "../../product.js";

export const EXTERNAL: AppTemplate = {
  id: EXTERNAL_TEMPLATE,
  name: "External service",
  summary:
    "Something running outside the cluster, like a VM, a NAS or a game server, published through the cluster's proxy.",
  image: "",
  version: "",
  port: 0,
};

// The manifests' own revision: an external service has no image, so this is
// what upgrades compare. Raise it when the rendered objects change shape.
export const EXTERNAL_VERSION = "1";

const PROTOCOLS = new Set(["http", "https", "tcp", "udp"]);
const TRAEFIK_API = "traefik.io/v1alpha1";

export const isForwarded = (spec: ExternalServiceSpec): spec is ExternalServiceSpec & { protocol: ForwardedProtocol } =>
  spec.protocol === "tcp" || spec.protocol === "udp";

export const publicPortOf = (spec: ExternalServiceSpec): number => spec.publicPort ?? spec.port;

const validPort = (port: unknown): port is number =>
  typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65_535;

// Loopback, link-local (cloud metadata lives there) and unspecified
// addresses would point the proxy at the node itself; the API server
// refuses them in an EndpointSlice too.
function unroutable(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 127 || (a === 169 && b === 254);
  }
  const lower = address.toLowerCase();
  return lower === "::" || lower === "::1" || /^fe[89ab]/.test(lower) || lower.startsWith("::ffff:");
}

// Field errors under "external.*".
export function checkExternal(spec: ExternalServiceSpec | undefined, errors: Record<string, string>): void {
  if (!spec) {
    errors.external = "required for an external service";
    return;
  }
  const address = spec.address?.trim() ?? "";
  if (isIP(address) === 0) errors["external.address"] = "must be an IP address like 10.0.0.50";
  else if (unroutable(address)) errors["external.address"] = "must be an address on your network, not this machine";
  if (!validPort(spec.port)) errors["external.port"] = "must be a port number from 1 to 65535";
  if (!PROTOCOLS.has(spec.protocol)) errors["external.protocol"] = "must be http, https, tcp or udp";
  if (spec.publicPort !== undefined) {
    if (!isForwarded(spec)) errors["external.publicPort"] = "only for tcp and udp";
    else if (!validPort(spec.publicPort)) errors["external.publicPort"] = "must be a port number from 1 to 65535";
  }
  if (spec.insecureSkipVerify && spec.protocol !== "https") errors["external.insecureSkipVerify"] = "only for https";
}

export function tidyExternal(spec: ExternalServiceSpec): ExternalServiceSpec {
  return {
    address: spec.address.trim(),
    port: spec.port,
    protocol: spec.protocol,
    ...(isForwarded(spec) && spec.publicPort !== undefined && spec.publicPort !== spec.port
      ? { publicPort: spec.publicPort }
      : {}),
    ...(spec.protocol === "https" && spec.insecureSkipVerify ? { insecureSkipVerify: true } : {}),
  };
}

// The public port against the forwarded range, Traefik's own ports and
// the other external services. Field errors under "external.publicPort".
export function checkPublicPort(
  name: string,
  spec: ExternalServiceSpec,
  ports: PortsView | undefined,
  errors: Record<string, string>
): void {
  if (!isForwarded(spec)) return;
  const field = spec.publicPort !== undefined ? "external.publicPort" : "external.port";
  const port = publicPortOf(spec);
  if (port < 1024) {
    errors[field] = "must be 1024 or above: lower ports would need Traefik to run with extra privileges";
    return;
  }
  if (RESERVED_PORTS.includes(port)) {
    errors[field] = `${port} is one of Traefik's own ports`;
    return;
  }
  if (!ports) return;
  if (ports.ranges.length === 0) {
    errors[field] =
      ports.rangeError ??
      "no forwarded ports are set: add the range your router forwards in Admin > Settings (Forwarded ports)";
    return;
  }
  if (!ports.ranges.some((r) => port >= r.from && port <= r.to)) {
    errors[field] = `outside the forwarded ports (${ports.range})`;
    return;
  }
  const other = ports.wanted.find((w) => w.appId !== name && w.port === port && w.protocol === spec.protocol);
  if (other) errors[field] = `${spec.protocol.toUpperCase()} ${port} is already used by ${other.appId}`;
}

// Warnings for the plan, chiefly when the port people use differs from the
// one the service listens on.
export function externalWarnings(spec: ExternalServiceSpec, host: string | undefined): string[] {
  const direct = `${spec.address.includes(":") ? `[${spec.address}]` : spec.address}:${spec.port}`;
  if (isForwarded(spec)) {
    const warnings = [
      "TCP and UDP can't go through a Cloudflare tunnel: people reach this on your public address at the " +
        "public port, through the ports your router forwards to the cluster.",
    ];
    if (publicPortOf(spec) !== spec.port) {
      warnings.unshift(
        `People connect on port ${publicPortOf(spec)} while the service listens on ${spec.port}. Games and ` +
          `protocols that tell clients their own port (server browsers, FTP, SIP) may only work when reached ` +
          `directly at ${direct}.`
      );
    }
    return warnings;
  }
  if (!host) return [];
  const standard = spec.protocol === "https" ? 443 : 80;
  return spec.port === standard
    ? []
    : [
        `The page is served at ${host} on the standard port while the service listens on ${spec.port}. An app ` +
          `that writes its own address into links or redirects may only work when reached directly at ${direct}.`,
      ];
}

export function wantedPort(name: string, spec: ExternalServiceSpec): WantedPort | undefined {
  return isForwarded(spec) ? { appId: name, port: publicPortOf(spec), protocol: spec.protocol } : undefined;
}

// A selector-less Service with an EndpointSlice at the address, a
// ServersTransport for a self-signed https target, and the Traefik route
// for tcp and udp. http and https get the deploy runner's Ingress, which
// points at the Service.
export function externalManifests(name: string, spec: ExternalServiceSpec, namespaceObject: KubeObject): KubeObject[] {
  const ns = name;
  const labels = { "app.kubernetes.io/name": name, ...deployedLabel() };
  const portName = spec.protocol;
  const wire = spec.protocol === "udp" ? "UDP" : "TCP";
  const transport = `${name}-insecure`;
  const annotations: Record<string, string> =
    spec.protocol === "https"
      ? {
          "traefik.ingress.kubernetes.io/service.serversscheme": "https",
          ...(spec.insecureSkipVerify
            ? { "traefik.ingress.kubernetes.io/service.serverstransport": `${ns}-${transport}@kubernetescrd` }
            : {}),
        }
      : {};
  const objects: KubeObject[] = [
    namespaceObject,
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name, namespace: ns, labels, ...(Object.keys(annotations).length ? { annotations } : {}) },
      spec: { ports: [{ name: portName, port: spec.port, targetPort: spec.port, protocol: wire }] },
    } as KubeObject,
    {
      apiVersion: "discovery.k8s.io/v1",
      kind: "EndpointSlice",
      metadata: {
        name: `${name}-external`,
        namespace: ns,
        labels: {
          ...labels,
          "kubernetes.io/service-name": name,
          // Anything but the EndpointSlice controller's own value, so it
          // leaves the slice alone.
          "endpointslice.kubernetes.io/managed-by": product.ownerMarker.labelDomain,
        },
      },
      addressType: isIP(spec.address) === 6 ? "IPv6" : "IPv4",
      endpoints: [{ addresses: [spec.address], conditions: { ready: true } }],
      ports: [{ name: portName, port: spec.port, protocol: wire }],
    } as unknown as KubeObject,
  ];
  if (spec.protocol === "https" && spec.insecureSkipVerify) {
    objects.push({
      apiVersion: TRAEFIK_API,
      kind: "ServersTransport",
      metadata: { name: transport, namespace: ns, labels },
      spec: { insecureSkipVerify: true },
    } as KubeObject);
  }
  if (isForwarded(spec)) {
    const entrypoint = traefikEntrypoint({ port: publicPortOf(spec), protocol: spec.protocol });
    const service = { name, port: spec.port };
    objects.push({
      apiVersion: TRAEFIK_API,
      kind: spec.protocol === "tcp" ? "IngressRouteTCP" : "IngressRouteUDP",
      metadata: { name, namespace: ns, labels },
      spec: {
        entryPoints: [entrypoint],
        routes: spec.protocol === "tcp" ? [{ match: "HostSNI(`*`)", services: [service] }] : [{ services: [service] }],
      },
    } as KubeObject);
  }
  return objects;
}

export const EXTERNAL_KINDS: ReadonlySet<string> = new Set([
  "EndpointSlice",
  "IngressRouteTCP",
  "IngressRouteUDP",
  "ServersTransport",
]);

// The health check watching the target itself, beside any check on its
// public URL: it tells "the VM is down" apart from "the proxy is". UDP has
// no handshake to check.
export function externalCheck(
  name: string,
  spec: ExternalServiceSpec
): { label: string; kind: "http" | "tcp"; target: string; insecureSkipVerify?: boolean } | undefined {
  const host = spec.address.includes(":") ? `[${spec.address}]` : spec.address;
  const label = `${name} (external)`;
  if (spec.protocol === "udp") return undefined;
  if (spec.protocol === "tcp") return { label, kind: "tcp", target: `${host}:${spec.port}` };
  return {
    label,
    kind: "http",
    target: `${spec.protocol}://${host}:${spec.port}/`,
    ...(spec.insecureSkipVerify ? { insecureSkipVerify: true } : {}),
  };
}

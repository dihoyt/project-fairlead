import type { CatalogEntry } from "../../contracts/catalog.js";
import { deployedLabel } from "../../contracts/deployed.js";
import type { KubeObject } from "../../contracts/k8s.js";
import { TEMPLATE_LABEL_SUFFIX, type EnvVar, type ExternalServiceSpec } from "../../contracts/templates.js";
import { externalManifests } from "./external.js";
import { product } from "../../product.js";
import type { TemplateDefinition } from "./library.js";
import { toYaml, type YamlValue } from "./yaml.js";

// One instance, resolved: what the manifests are rendered from.
export interface Resolved {
  templateId: string;
  name: string;
  displayName: string;
  summary: string;
  homepage?: string;
  // "docker.io/traefik/whoami:v1.11.0" or "...@sha256:...".
  image: string;
  version: string;
  port: number;
  env: EnvVar[];
  volume?: { mountPath: string; size: string; storageClass?: string };
  probePath?: string;
  // Rendered with an Ingress from the deploy runner: a host was given or defaulted.
  exposed: boolean;
  disk?: { volumeBytes: number; imageBytes: number };
  noLogin?: boolean;
  // The external template: no workload, the Service points at this.
  external?: ExternalServiceSpec;
}

export const templateLabel = () => `${product.ownerMarker.labelDomain}/${TEMPLATE_LABEL_SUFFIX}`;

const SELECTOR = "app.kubernetes.io/name";

export function fromDefinition(
  def: TemplateDefinition,
  name: string,
  options: { exposed: boolean; volumeSize?: string; storageClass?: string }
): Resolved {
  return {
    templateId: def.id,
    name,
    displayName: def.name,
    summary: def.summary,
    ...(def.homepage ? { homepage: def.homepage } : {}),
    image: `${def.image}:${def.version}`,
    version: def.version,
    port: def.port,
    env: def.env ?? [],
    ...(def.noLogin ? { noLogin: true } : {}),
    ...(def.volume
      ? {
          volume: {
            mountPath: def.volume.mountPath,
            size: options.volumeSize || def.volume.size,
            ...(options.storageClass ? { storageClass: options.storageClass } : {}),
          },
        }
      : {}),
    ...(def.probePath ? { probePath: def.probePath } : {}),
    exposed: options.exposed,
    ...(def.disk ? { disk: def.disk } : {}),
  };
}

export function manifests(r: Resolved): KubeObject[] {
  const labels = { [SELECTOR]: r.name };
  const ns = r.name;
  const claim = `${r.name}-data`;
  const namespace: KubeObject = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: ns,
      labels: {
        "app.kubernetes.io/managed-by": product.ownerMarker.labelDomain,
        ...deployedLabel(),
        [templateLabel()]: r.templateId,
        // The API server refuses privileged pods, host paths, host
        // networking and extra capabilities here, whoever applies them.
        "pod-security.kubernetes.io/enforce": "baseline",
        "pod-security.kubernetes.io/enforce-version": "latest",
      },
    },
  };
  if (r.external) return externalManifests(r.name, r.external, namespace);
  const probe = r.probePath ? { httpGet: { path: r.probePath, port: r.port } } : { tcpSocket: { port: r.port } };
  const container: Record<string, YamlValue> = {
    name: r.name,
    image: r.image,
    ports: [{ name: "http", containerPort: r.port }],
    ...(r.env.length ? { env: r.env.map((e) => ({ name: e.name, value: e.value })) } : {}),
    securityContext: { allowPrivilegeEscalation: false },
    readinessProbe: { ...probe, periodSeconds: 10 },
    ...(r.volume ? { volumeMounts: [{ name: "data", mountPath: r.volume.mountPath }] } : {}),
  };
  const objects: KubeObject[] = [namespace];
  if (r.volume) {
    objects.push({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: claim, namespace: ns, labels: { ...labels, ...deployedLabel() } },
      spec: {
        accessModes: ["ReadWriteOnce"],
        ...(r.volume.storageClass ? { storageClassName: r.volume.storageClass } : {}),
        resources: { requests: { storage: r.volume.size } },
      },
    });
  }
  objects.push(
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: r.name, namespace: ns, labels: { ...labels, ...deployedLabel() } },
      spec: {
        replicas: 1,
        // A ReadWriteOnce volume can't be mounted by the new pod while the
        // old one still has it.
        ...(r.volume ? { strategy: { type: "Recreate" } } : {}),
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            securityContext: { seccompProfile: { type: "RuntimeDefault" } },
            containers: [container],
            ...(r.volume ? { volumes: [{ name: "data", persistentVolumeClaim: { claimName: claim } }] } : {}),
          },
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: r.name, namespace: ns, labels: { ...labels, ...deployedLabel() } },
      spec: { selector: labels, ports: [{ name: "http", port: r.port, targetPort: r.port }] },
    }
  );
  return objects;
}

export const toDocuments = (objects: readonly KubeObject[]) =>
  objects.map((o) => toYaml(o as unknown as YamlValue)).join("---\n");

// The instance as the deploy runner sees it: a bundled manifest in its own
// namespace, with a "host" input when it gets an Ingress.
export function entryFor(r: Resolved, objects: readonly KubeObject[]): CatalogEntry {
  return {
    id: r.name,
    name: r.name === r.templateId ? r.displayName : `${r.name} (${r.displayName})`,
    summary: r.summary,
    slots: [],
    homepage: r.homepage ?? "",
    install: { kind: "manifest", bundled: toDocuments(objects), version: r.version },
    namespace: r.name,
    requires: [],
    inputs: r.exposed ? [{ key: "host", label: "Hostname", kind: "hostname", required: false }] : [],
    exposesUi: r.exposed,
    ...(r.volume ? { storage: r.volume.size } : {}),
    ...(r.disk ? { disk: r.disk } : {}),
    prerequisites: [],
    ...(r.noLogin ? { noLogin: true } : {}),
  };
}

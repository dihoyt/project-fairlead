import type { KubeConfig } from "@kubernetes/client-node";
import { RESOURCES } from "../../contracts/k8s.js";
import type { AccessCheck, Capability, CapabilityReport, ResourceRef } from "../../contracts/k8s.js";
import type { Discovery } from "./discovery.js";
import { groupShortName } from "./paths.js";
import { requestJson } from "./transport.js";

interface ReviewResponse {
  status?: { allowed?: boolean; denied?: boolean; reason?: string };
}

export const accessKey = (check: AccessCheck) =>
  [
    check.verb,
    check.group,
    check.resource + (check.subresource ? `/${check.subresource}` : ""),
    check.namespace ?? "",
  ].join(" ");

// "list on longhorn.io/volumes", "get on nodes/proxy".
export function describeCheck(check: AccessCheck): string {
  const resource = `${check.resource}${check.subresource ? `/${check.subresource}` : ""}`;
  const where = check.namespace ? ` in namespace ${check.namespace}` : "";
  return `${check.verb} on ${check.group ? `${check.group}/` : ""}${resource}${where}`;
}

// SelfSubjectAccessReview, the API server's own answer to "may I", so the
// result is right for any authorizer (RBAC, webhook, node) without reading
// roles. Cached briefly: a capability report asks ~30 of these.
export class AccessReviewer {
  private readonly cache = new Map<string, { at: number; allowed: boolean }>();
  private readonly kc: () => KubeConfig;
  private readonly ttlMs: number;

  constructor(kc: () => KubeConfig, ttlMs = 60_000) {
    this.kc = kc;
    this.ttlMs = ttlMs;
  }

  async can(check: AccessCheck, refresh = false): Promise<boolean> {
    const key = accessKey(check);
    const hit = this.cache.get(key);
    if (!refresh && hit && Date.now() - hit.at < this.ttlMs) return hit.allowed;
    const review = await requestJson<ReviewResponse>(
      this.kc(),
      "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
      {
        method: "POST",
        body: {
          apiVersion: "authorization.k8s.io/v1",
          kind: "SelfSubjectAccessReview",
          spec: {
            resourceAttributes: {
              verb: check.verb,
              group: check.group,
              resource: check.resource,
              subresource: check.subresource,
              namespace: check.namespace,
            },
          },
        },
      }
    );
    const allowed = review.status?.allowed === true && review.status.denied !== true;
    this.cache.set(key, { at: Date.now(), allowed });
    return allowed;
  }

  forget(): void {
    this.cache.clear();
  }
}

// Grants the chart withholds unless an install turns them on: Secret reads
// expose Secret contents, so rbac.secrets.enabled is off by default.
export const OPT_IN_CAPABILITIES: ReadonlySet<string> = new Set(["core.secrets"]);

interface CapabilitySpec {
  id: string;
  label: string;
  ref: ResourceRef;
  check: AccessCheck;
}

// Every read Milestone A makes: list on each resource, plus the two
// subresources the chart grants, kubelet stats and pod logs.
export function capabilitySpecs(): CapabilitySpec[] {
  const specs: CapabilitySpec[] = Object.values<ResourceRef>(RESOURCES).map((ref) => ({
    id: `${groupShortName(ref.group)}.${ref.plural}`,
    label: ref.group ? `${ref.kind} (${ref.group})` : ref.kind,
    ref,
    check: { verb: "list", group: ref.group, resource: ref.plural },
  }));
  specs.push(
    {
      id: "core.nodes/proxy",
      label: "Kubelet stats",
      ref: RESOURCES.nodes,
      check: { verb: "get", group: "", resource: "nodes", subresource: "proxy" },
    },
    {
      id: "core.pods/log",
      label: "Pod logs",
      ref: RESOURCES.pods,
      check: { verb: "get", group: "", resource: "pods", subresource: "log" },
    }
  );
  return specs;
}

export async function buildCapabilityReport(
  reviewer: AccessReviewer,
  discovery: Discovery,
  refresh: boolean,
  now: () => Date = () => new Date()
): Promise<CapabilityReport> {
  const capabilities = await Promise.all(
    capabilitySpecs().map(async ({ id, label, ref, check }): Promise<Capability> => {
      const groupPresent = await discovery.groupPresent(ref, refresh);
      // An unserved group is "install X", whatever RBAC would say.
      const allowed = groupPresent && (await reviewer.can(check, refresh));
      const needs = allowed ? undefined : groupPresent ? describeCheck(check) : `${ref.group} installed`;
      return {
        id,
        label,
        check,
        allowed,
        groupPresent,
        ...(needs ? { needs } : {}),
        ...(OPT_IN_CAPABILITIES.has(id) ? { optIn: true } : {}),
      };
    })
  );
  return { checkedAt: now().toISOString(), capabilities };
}

// For a report when there is no cluster to ask.
export function unconfiguredReport(now: Date = new Date()): CapabilityReport {
  return {
    checkedAt: now.toISOString(),
    capabilities: capabilitySpecs().map(({ id, label, check }) => ({
      id,
      label,
      check,
      allowed: false,
      groupPresent: false,
      needs: "a Kubernetes connection",
      ...(OPT_IN_CAPABILITIES.has(id) ? { optIn: true } : {}),
    })),
  };
}

import type { KubeConfig } from "@kubernetes/client-node";
import type { ResourceRef } from "../../contracts/k8s.js";
import { groupVersionPath } from "./paths.js";
import { K8sError, requestJson } from "./transport.js";

interface ResourceList {
  resources?: Array<{ name: string }>;
}

// Which group/versions and resources the cluster serves, cached per
// group/version so installing a CRD shows up within one TTL without a
// discovery call on every list.
export class Discovery {
  private readonly cache = new Map<string, { at: number; resources: Set<string> | null }>();
  private readonly inflight = new Map<string, Promise<Set<string> | null>>();
  private readonly kc: () => KubeConfig;
  private readonly ttlMs: number;

  constructor(kc: () => KubeConfig, ttlMs = 60_000) {
    this.kc = kc;
    this.ttlMs = ttlMs;
  }

  // null when the group/version is not served at all.
  async resources(ref: Pick<ResourceRef, "group" | "version">, refresh = false): Promise<Set<string> | null> {
    const key = groupVersionPath(ref);
    const hit = this.cache.get(key);
    if (!refresh && hit && Date.now() - hit.at < this.ttlMs) return hit.resources;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const load = (async () => {
      try {
        const list = await requestJson<ResourceList>(this.kc(), key);
        return new Set((list.resources ?? []).map((r) => r.name));
      } catch (err) {
        if (err instanceof K8sError && err.statusCode === 404) return null;
        throw err;
      }
    })();
    this.inflight.set(key, load);
    try {
      const resources = await load;
      this.cache.set(key, { at: Date.now(), resources });
      return resources;
    } finally {
      this.inflight.delete(key);
    }
  }

  async groupPresent(ref: Pick<ResourceRef, "group" | "version">, refresh = false): Promise<boolean> {
    return (await this.resources(ref, refresh)) !== null;
  }

  async served(ref: ResourceRef, subresource?: string, refresh = false): Promise<boolean> {
    const resources = await this.resources(ref, refresh);
    return !!resources?.has(subresource ? `${ref.plural}/${subresource}` : ref.plural);
  }

  forget(): void {
    this.cache.clear();
  }
}

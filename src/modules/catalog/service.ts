import type { CatalogBundle, CatalogEntry, CatalogService, DiscoveryReport } from "../../contracts/catalog.js";
import type { K8sApi } from "../../contracts/k8s.js";
import { discover } from "./discover.js";

export const DISCOVERY_TTL_MS = 30_000;

export interface CatalogServiceOptions {
  k8s: () => K8sApi;
  entries: readonly CatalogEntry[];
  bundles?: readonly CatalogBundle[];
  ttlMs?: number;
  now?: () => number;
}

export function createCatalogService(options: CatalogServiceOptions): CatalogService {
  const { entries } = options;
  const ttl = options.ttlMs ?? DISCOVERY_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: { at: number; report: DiscoveryReport } | undefined;
  // Callers arriving while a look is in flight share it instead of starting another.
  let inflight: Promise<DiscoveryReport> | undefined;

  const look = () => {
    const started = now();
    const run = discover(options.k8s(), entries, () => new Date(started))
      .then((report) => {
        cached = { at: started, report };
        return report;
      })
      .finally(() => {
        if (inflight === run) inflight = undefined;
      });
    inflight = run;
    return run;
  };

  return {
    entries: () => entries,
    get: (appId) => entries.find((entry) => entry.id === appId),
    bundles: () => options.bundles ?? [],
    async discover(refresh = false) {
      if (!refresh && cached && now() - cached.at < ttl) return structuredClone(cached.report);
      if (!refresh && inflight) return structuredClone(await inflight);
      return structuredClone(await look());
    },
  };
}

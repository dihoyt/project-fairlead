import type { CatalogEntry } from "../catalog.js";
import type { AccessView, DeployedRelease, DeployJobRequest, DeployRequest, DeployService } from "../deploy.js";
import { mockAccess, mockDeployJob, mockDeployPlan } from "./catalog.js";

// Headlamp installed by the runner, Longhorn's install failed.
export const mockDeployedReleases: DeployedRelease[] = [
  { appId: "headlamp", release: "headlamp", namespace: "headlamp", jobId: "dj_1", state: "succeeded" },
  { appId: "longhorn", release: "longhorn", namespace: "longhorn-system", jobId: "dj_3", state: "failed" },
];

// planEntry and startEntry answer with the generic plan and job, renamed to
// the entry, and record what they were given.
export interface MockDeployService extends DeployService {
  planned: Array<{ entry: CatalogEntry; request: DeployRequest }>;
  started: Array<{ actor: string; entry: CatalogEntry; request: DeployJobRequest }>;
}

const named = (entry: CatalogEntry) => ({ appId: entry.id, release: entry.id, namespace: entry.namespace });

export function createMockDeployService(
  releases: DeployedRelease[] = mockDeployedReleases,
  access: AccessView = mockAccess
): MockDeployService {
  const service: MockDeployService = {
    planned: [],
    started: [],
    releases: async () => structuredClone(releases),
    access: async () => structuredClone(access),
    planEntry: async (entry, request) => {
      service.planned.push({ entry, request });
      return {
        ...structuredClone(mockDeployPlan),
        ...named(entry),
        version: entry.install.kind === "patch" ? "" : entry.install.version,
      };
    },
    startEntry: async (actor, entry, request) => {
      service.started.push({ actor, entry, request });
      return { ...structuredClone(mockDeployJob), ...named(entry), mode: request.mode, state: "pending" };
    },
  };
  return service;
}

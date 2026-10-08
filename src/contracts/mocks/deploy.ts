import type { AccessView, DeployedRelease, DeployService } from "../deploy.js";
import { mockAccess } from "./catalog.js";

// Headlamp installed by the runner, Longhorn's install failed.
export const mockDeployedReleases: DeployedRelease[] = [
  { appId: "headlamp", release: "headlamp", namespace: "headlamp", jobId: "dj_1", state: "succeeded" },
  { appId: "longhorn", release: "longhorn", namespace: "longhorn-system", jobId: "dj_3", state: "failed" },
];

export function createMockDeployService(
  releases: DeployedRelease[] = mockDeployedReleases,
  access: AccessView = mockAccess
): DeployService {
  return { releases: async () => structuredClone(releases), access: async () => structuredClone(access) };
}

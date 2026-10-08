import type { DeployedRelease, DeployService } from "../deploy.js";

// Headlamp installed by the runner, Longhorn's install failed.
export const mockDeployedReleases: DeployedRelease[] = [
  { appId: "headlamp", release: "headlamp", namespace: "headlamp", jobId: "dj_1", state: "succeeded" },
  { appId: "longhorn", release: "longhorn", namespace: "longhorn-system", jobId: "dj_3", state: "failed" },
];

export function createMockDeployService(releases: DeployedRelease[] = mockDeployedReleases): DeployService {
  return { releases: async () => structuredClone(releases) };
}

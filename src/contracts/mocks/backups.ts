import type { BackupSource, BackupTarget, CapacitySource, ProtectedVolume, PvcRef } from "../backups.js";
import { DAY, HOUR, isoAgo } from "./time.js";

export const mockPvcs = {
  postgres: { namespace: "apps", name: "postgres-data", uid: "11111111-0000-4000-8000-000000000001" },
  gitea: { namespace: "gitea", name: "gitea-shared-storage", uid: "11111111-0000-4000-8000-000000000002" },
  grafana: { namespace: "monitoring", name: "grafana", uid: "11111111-0000-4000-8000-000000000003" },
  jellyfin: { namespace: "media", name: "jellyfin-config", uid: "11111111-0000-4000-8000-000000000004" },
  scratch: { namespace: "apps", name: "scratch-cache", uid: "11111111-0000-4000-8000-000000000005" },
} satisfies Record<string, PvcRef>;

export const mockTargets = {
  nas: { id: "longhorn:nfs://nas.local/backups", label: "NAS nfs://nas.local/backups", url: "nfs://nas.local/backups" },
  s3: { id: "velero:default", label: "Velero default (s3://cluster-backups)", url: "s3://cluster-backups" },
} satisfies Record<string, BackupTarget>;

// Protected and fresh, with restore evidence.
export const mockProtectedVolume: ProtectedVolume = {
  pvc: mockPvcs.postgres,
  sourceId: "longhorn",
  policy: {
    description: "Longhorn recurring job daily-backup (0 2 * * *)",
    expectedEveryMs: DAY,
    certainty: "certain",
  },
  lastGood: { at: isoAgo(10 * HOUR), ref: "backup-6f1c2a" },
  lastAttempt: { at: isoAgo(10 * HOUR), ok: true },
  target: mockTargets.nas,
  restoreEvidence: { at: isoAgo(20 * DAY), ref: "pvc-restore-test-postgres", kind: "volume-from-backup" },
};

// Covered, but the last good backup is three days old against a daily policy.
export const mockStaleVolume: ProtectedVolume = {
  pvc: mockPvcs.gitea,
  sourceId: "velero",
  policy: { description: "Velero schedule nightly (namespace gitea)", expectedEveryMs: DAY, certainty: "probable" },
  lastGood: { at: isoAgo(3 * DAY), ref: "nightly-20261004020000" },
  lastAttempt: { at: isoAgo(3 * DAY), ok: true },
  target: mockTargets.s3,
};

// Covered, but the latest attempt failed.
export const mockFailingVolume: ProtectedVolume = {
  pvc: mockPvcs.grafana,
  sourceId: "longhorn",
  policy: {
    description: "Longhorn recurring job daily-backup (0 2 * * *)",
    expectedEveryMs: DAY,
    certainty: "certain",
  },
  lastGood: { at: isoAgo(2 * DAY + 10 * HOUR), ref: "backup-0a9b3c" },
  lastAttempt: { at: isoAgo(10 * HOUR), ok: false, message: "backup target unreachable: connection refused" },
  target: mockTargets.nas,
};

// Covered, never backed up yet.
export const mockNeverBackedUpVolume: ProtectedVolume = {
  pvc: mockPvcs.jellyfin,
  sourceId: "longhorn",
  policy: { description: "Longhorn recurring job weekly (0 3 * * 0)", expectedEveryMs: 7 * DAY, certainty: "certain" },
  target: mockTargets.nas,
};

export const mockProtectedVolumes: ProtectedVolume[] = [
  mockProtectedVolume,
  mockStaleVolume,
  mockFailingVolume,
  mockNeverBackedUpVolume,
];

// In the cluster's PVC list but covered by no source.
export const mockUnprotectedPvcs: PvcRef[] = [mockPvcs.scratch];

export function createMockBackupSource(
  id: string,
  volumes: ProtectedVolume[] | "absent" = mockProtectedVolumes.filter((v) => v.sourceId === id)
): BackupSource {
  return { id, label: id, list: async () => (volumes === "absent" ? "absent" : volumes.map((v) => ({ ...v }))) };
}

export const mockLonghornSource = createMockBackupSource("longhorn");
export const mockVeleroSource = createMockBackupSource("velero");
export const mockAbsentSource = createMockBackupSource("velero", "absent");

export function createMockCapacitySource(
  target: BackupTarget = mockTargets.nas,
  free = 1.2e12,
  total = 4e12
): CapacitySource {
  return {
    id: `capacity:${target.id}`,
    targetMatch: (candidate) => candidate.id === target.id,
    freeBytes: async () => ({ free, total }),
  };
}

export const mockCapacitySource = createMockCapacitySource();

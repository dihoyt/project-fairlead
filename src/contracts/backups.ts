import type { Status } from "./health.js";

export interface PvcRef {
  namespace: string;
  name: string;
  uid: string;
}

export interface BackupTarget {
  // Stable per source: "longhorn:s3://bucket@region/", "velero:default".
  id: string;
  label: string;
  url?: string;
}

export interface ProtectedVolume {
  pvc: PvcRef;
  // "longhorn", "velero".
  sourceId: string;
  policy: {
    // "Longhorn recurring job daily-backup (0 2 * * *)".
    description: string;
    // How often a good backup is expected; drives the age-vs-policy judgement.
    expectedEveryMs?: number;
    // Coverage the source could not prove, e.g. a Velero selector it could
    // only partly resolve. Shown as "probably covered".
    certainty?: "certain" | "probable";
  };
  lastGood?: { at: string; ref: string };
  lastAttempt?: { at: string; ok: boolean; message?: string };
  target: BackupTarget;
  restoreEvidence?: { at: string; ref: string; kind: "restore-object" | "volume-from-backup" };
}

export interface BackupSource {
  id: string;
  label: string;
  // "absent" when the backup system is not installed in this cluster.
  list(): Promise<ProtectedVolume[] | "absent">;
}

export interface CapacitySource {
  id: string;
  targetMatch(target: BackupTarget): boolean;
  freeBytes(): Promise<{ free: number; total: number }>;
}

export interface BackupsRegistry {
  addSource(source: BackupSource): void;
  addCapacity(capacity: CapacitySource): void;
  sources(): readonly BackupSource[];
  capacities(): readonly CapacitySource[];
  subscribe(listener: {
    onSource?(source: BackupSource): void;
    onCapacity?(capacity: CapacitySource): void;
  }): () => void;
}

// --- HTTP shapes (module "backups", A12) ---------------------------------

export interface RestoreTestMark {
  at: string;
  note: string;
  by: string;
}

export interface PostureRow {
  pvc: PvcRef & { sizeBytes?: number; storageClass?: string };
  // The workload that mounts it: "Deployment/grafana".
  app?: string;
  // Empty when nothing covers the PVC; such rows sort first.
  coverage: ProtectedVolume[];
  protected: boolean;
  lastGood?: { at: string; ref: string; sourceId: string };
  ageStatus: Status;
  ageDetail: string;
  target?: BackupTarget & { free?: number; total?: number };
  // The newer of source evidence and a manual mark.
  restoreTested?: { at: string; from: "evidence" | "manual"; ref?: string; note?: string };
  status: Status;
}

export interface BackupPosture {
  rows: PostureRow[];
  sources: Array<{ id: string; label: string; state: "ok" | "absent" | "error"; volumes: number; error?: string }>;
  generatedAt: string;
}

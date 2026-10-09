import type { StorageProtocol } from "./connectors.js";
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
  // Longhorn volumes only: the RecurringJob groups it is in ("default"
  // when it carries no group label of its own).
  groups?: string[];
  // The newest completed Longhorn backup of it, whatever its schedule.
  lastBackupAt?: string;
}

export interface BackupPosture {
  rows: PostureRow[];
  sources: Array<{ id: string; label: string; state: "ok" | "absent" | "error"; volumes: number; error?: string }>;
  generatedAt: string;
  // Longhorn's backup target as the console set it (GET /api/backups/target).
  target?: BackupTargetView;
  // The schedules in force (GET /api/backups/schedules).
  schedules?: BackupSchedule[];
}

// --- Backup set-up (module "backups", round 4) -------------------------------
// The Backups page sets up Longhorn itself, headless: a backup target from a
// storage-target connector (./connectors.ts), recurring snapshot and backup
// schedules per group, backup now, restore. Every change runs as a deploy
// action (./deploy.ts: longhorn-target, longhorn-recurring,
// longhorn-backup-now, longhorn-restore), so the routes below that change
// something answer with the deploy job they started.

// One Longhorn RecurringJob group's schedule. Longhorn's own "default" group
// covers every volume that is in no other group, so volumes created later
// are covered without the console acting. A cron left out turns that half
// off. Crons are Longhorn's five-field cron, in the cluster's time zone (UTC
// unless set otherwise).
export interface BackupSchedule {
  // "default", "critical", or a name of the admin's: lower-case letters,
  // digits and dashes, at most 40 characters.
  group: string;
  snapshotCron?: string;
  // Snapshots kept, 1 to 250. Default 24.
  snapshotRetain?: number;
  backupCron?: string;
  // Backups kept on the target, 1 to 250. Default 14.
  backupRetain?: number;
}

export interface BackupSchedulesView {
  // What Longhorn's RecurringJobs carry now (only the ones this product
  // made); empty when none is set.
  schedules: BackupSchedule[];
  // Offered while schedules is empty: default snapshot hourly keep 24 and
  // backup daily 03:00 keep 14; critical backup every 6 hours keep 28.
  suggested?: BackupSchedule[];
  // Longhorn's RecurringJob CRD is not served.
  longhorn: "installed" | "absent";
}

export interface BackupSchedulesRequest {
  // The whole set: a group left out loses its RecurringJobs (its volumes'
  // labels stay; they then fall back to default only if they have no other).
  schedules: BackupSchedule[];
}

// A volume's groups. An empty list puts it back in "default".
export interface VolumeBackupSettings {
  groups: string[];
}

export interface BackupTargetView {
  // The storage-target connector Longhorn's default BackupTarget was set
  // from; unset while none is, or when its URL matches no connector.
  connectorId?: string;
  name?: string;
  protocol?: StorageProtocol;
  // BackupTarget.spec.backupTargetURL as Longhorn has it; "" when unset.
  url: string;
  // BackupTarget.status.available; absent until Longhorn reports.
  available?: boolean;
  // Longhorn's condition message, verbatim, when it says one.
  message?: string;
  // BackupTarget.status.lastSyncedAt.
  lastSyncAt?: string;
  // Longhorn's BackupTarget CRD is not served.
  longhorn: "installed" | "absent";
}

// connectorId: a storage-target connector; null clears Longhorn's target.
export interface BackupTargetRequest {
  connectorId: string | null;
}

// A backup of one volume on the target that a restore can start from.
export interface VolumeRestorePoint {
  // The Longhorn Backup's name.
  id: string;
  // When the snapshot it was taken from was made.
  at: string;
  state: "completed" | "in-progress" | "error";
  sizeBytes?: number;
  // The RecurringJob that made it, or "manual".
  createdBy?: string;
  // The Backup's URL on the target, for display.
  url?: string;
  message?: string;
}

// new-pvc (the default): a new claim beside the old one, the app untouched.
// in-place: the app's workloads scale to zero, the claim is rebound under the
// same name to a volume restored from the backup, then they scale back up.
export type RestoreMode = "new-pvc" | "in-place";

export interface VolumeRestoreRequest {
  // The PVC's uid.
  uid: string;
  // VolumeRestorePoint.id.
  backupId: string;
  mode: RestoreMode;
  // new-pvc only. Default "<claim>-restored-<yyyymmdd>".
  newClaim?: string;
}

// --- Longhorn replica advice (module "longhorn") ----------------------------
// Volumes keep the replica count they were created with, so a cluster that
// grows from one node keeps single-replica volumes until someone raises them.
// The target is min(2, schedulable nodes): a second copy on another node,
// never more replicas than nodes to put them on. Raising is one click
// (DeployActionRequest "longhorn-replicas"); nothing raises by itself.

export interface LonghornReplicaVolume {
  // The Longhorn Volume's name.
  name: string;
  replicas: number;
  pvc?: { namespace: string; name: string };
}

export interface LonghornReplicaAdvice {
  // absent: Longhorn is not installed. ok: nothing below target.
  // raise: the Setting, a StorageClass or a volume is below target.
  // unknown: Longhorn's objects could not be read; error says why.
  state: "absent" | "ok" | "raise" | "unknown";
  // Longhorn nodes that are Ready with scheduling allowed.
  schedulableNodes: number;
  target: number;
  // The default-replica-count Setting.
  defaultReplicaCount?: number;
  // StorageClasses with Longhorn's provisioner that pin numberOfReplicas
  // below target.
  storageClasses: Array<{ name: string; replicas: number }>;
  // Volumes below target, fewest replicas first.
  volumes: LonghornReplicaVolume[];
  // One sentence: "3 volumes have 1 replica; 2 nodes can hold 2."
  detail: string;
  error?: string;
  checkedAt: string;
}

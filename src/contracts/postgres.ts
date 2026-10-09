// Shared Postgres (module "postgres"). CloudNativePG's operator runs one
// shared Cluster in its own namespace; apps that need Postgres
// (CatalogEntry.database) each get their own database and login role on it
// instead of a Postgres bundled with their chart. The console reads the
// operator's objects; every change runs as a deploy action (./deploy.ts:
// pg-database, pg-backups, pg-backup-now, pg-restore, pg-remove-cluster)
// under the installer ServiceAccount, so this product's own ServiceAccount
// stays read-only.
//
// Server-free on purpose: the client imports this file.

import type { StorageProtocol } from "./connectors.js";
import type { Status } from "./health.js";

// Catalog ids. The operator; its Barman Cloud plugin (object-storage
// backups and WAL archiving, needs cert-manager); the shared Cluster, a
// "patch" entry that renders the Cluster object from a fixed template.
export const CNPG_APP = "cloudnative-pg";
export const BARMAN_CLOUD_APP = "barman-cloud";
export const POSTGRES_APP = "postgres";

// Where the shared Cluster, its databases' objects and its backups live.
export const POSTGRES_NAMESPACE = "postgres";

// The first shared Cluster's name, from product.json's slug.
export const pgClusterName = (slug: string): string => `${slug}-postgres`;

// Label, under ownerMarker.labelDomain, on every shared Cluster this product
// made: "current" on the one the apps use, "previous" on ones a restore
// replaced. Readers find the cluster by it, never by name.
export const pgClusterLabel = (labelDomain: string): string => `${labelDomain}/postgres`;

// The database and role an app gets: its catalog id with dashes as
// underscores ("pocket-id" -> "pocket_id").
export const pgName = (appId: string): string => appId.replace(/-/g, "_");

// The app's connection Secret in its own namespace, keys host, port,
// dbname, user, password and uri. Apps read their connection from it, so a
// restore re-points an app by rewriting it and restarting the app.
export const pgSecretName = (appId: string): string => `${appId}-postgres`;

// --- The cluster ----------------------------------------------------------

// absent: no shared Cluster (see PostgresClusterView.operator for why).
// starting: created, not every instance ready yet, never ready before.
// ready: every instance ready.
// degraded: was ready, now an instance is not, or the operator reports a
//   phase other than healthy.
// unknown: the operator's objects could not be read; error says why.
export type PostgresState = "absent" | "starting" | "ready" | "degraded" | "unknown";

export interface PostgresInstanceView {
  pod: string;
  node?: string;
  role: "primary" | "replica";
  ready: boolean;
}

export interface PostgresClusterView {
  // CloudNativePG's CRDs are served.
  operator: "installed" | "absent";
  // The Barman Cloud plugin's ObjectStore CRD is served: point-in-time
  // backups to S3/MinIO need it.
  barmanCloud: "installed" | "absent";
  state: PostgresState;
  namespace: string;
  // The Cluster the apps use now: the product's own name, or the cluster a
  // restore made. Absent with state "absent".
  name?: string;
  // The operator's status.phase, verbatim ("Cluster in healthy state").
  phase?: string;
  // status.phaseReason, when it gives one.
  message?: string;
  // Postgres version from the instances' image ("17.6").
  version?: string;
  instances: number;
  readyInstances: number;
  instanceList: PostgresInstanceView[];
  storageClass?: string;
  // Each instance's volume as requested ("10Gi").
  size?: string;
  // Clusters a restore replaced: hibernated (no pods, volumes kept) until
  // removed with pg-remove-cluster, newest first.
  previous: Array<{ name: string; hibernated: boolean; createdAt?: string }>;
  checkedAt: string;
  error?: string;
}

export interface PostgresDatabaseView {
  database: string;
  // The database's owner, the app's login role.
  role: string;
  // The catalog app it serves; absent for a database this product didn't
  // create.
  appId?: string;
  // The app's connection Secret (pgSecretName), when this product made one.
  secret?: { namespace: string; name: string };
  // The operator applied the Database and DatabaseRole objects
  // (status.applied on both).
  applied: boolean;
  // The operator's message when not applied, verbatim.
  message?: string;
  // From the primary's metrics, when they could be read.
  sizeBytes?: number;
  connections?: number;
}

// --- Backups ----------------------------------------------------------------
// The Barman Cloud plugin speaks object storage only, so which storage
// target the backups go to decides how far back and how finely a restore
// can reach:
// pitr: an S3/MinIO target. Base backups on a schedule and every WAL
//   segment archived as it fills: restore to any moment since
//   firstRecoverabilityPoint.
// dump: an NFS or SMB target. A pg_dumpall on a schedule onto a Longhorn
//   volume in the "critical" backup group, which Longhorn backs up to its
//   target, so the target must be Longhorn's: restore to the moment of a
//   dump.
// none: not set up.
export type PostgresBackupMethod = "pitr" | "dump" | "none";

export interface PostgresRestorePoint {
  // pitr: the operator's Backup object; dump: the dump Job.
  id: string;
  kind: "base-backup" | "dump";
  // When it finished (pitr: status.stoppedAt), or started while running.
  at: string;
  state: "completed" | "running" | "failed";
  message?: string;
}

export interface PostgresBackupView {
  method: PostgresBackupMethod;
  // One sentence: why this method for this target ("NFS takes no WAL
  // archive: nightly dumps, restore to the night of a dump"), or for none
  // what setting one up needs.
  reason: string;
  connectorId?: string;
  targetName?: string;
  protocol?: StorageProtocol;
  // pitr: where the archive is written ("s3://backups/cluster-a/postgres/");
  // dump: the dumps' claim, "postgres/<cluster>-dumps".
  destination?: string;
  // Five-field cron of the base backups (pitr) or the dumps (dump), in the
  // cluster's time zone.
  schedule?: string;
  // pitr: days of base backups and WAL kept. dump: dumps kept.
  retention?: number;
  // Worst of archiving, the last backup's age against the schedule and
  // the last failure; "unknown" until there is something to judge.
  status: Status;
  detail: string;
  // pitr only.
  firstRecoverabilityPoint?: string;
  lastBaseBackup?: string;
  lastFailedBackup?: { at: string; message?: string };
  // The Cluster's ContinuousArchiving condition.
  archiving?: { ok: boolean; message?: string };
  // Seconds since the last WAL segment reached the archive.
  walArchiveLagSeconds?: number;
  // dump only.
  lastDump?: { at: string; ok: boolean; message?: string };
  // Newest first; empty when none.
  restorePoints: PostgresRestorePoint[];
  checkedAt: string;
}

// connectorId: a storage-target connector; its protocol picks the method
// (s3: pitr, nfs and smb: dump). null turns backups off: archiving and
// dumps stop, backups already on the target stay there.
export interface PostgresBackupRequest {
  connectorId: string | null;
  // Five-field cron. Default "0 2 * * *".
  schedule?: string;
  // pitr: days kept, 1 to 365, default 14. dump: dumps kept, 1 to 60,
  // default 14.
  retention?: number;
}

// Exactly one of the two, matching the method in force.
export interface PostgresRestoreRequest {
  // pitr: the moment to recover to (ISO-8601), between
  // firstRecoverabilityPoint and now.
  at?: string;
  // dump: a PostgresRestorePoint.id of kind "dump".
  dumpId?: string;
}

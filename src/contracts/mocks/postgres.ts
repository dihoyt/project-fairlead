// The shared Postgres: a two-instance cluster serving Authentik and Grafana,
// backed up point-in-time to the S3 mock storage target, plus the dump and
// not-set-up variants. Pure data, so the client can import it.
import type { DeployActionPlan, DeployJobView } from "../deploy.js";
import type {
  PostgresBackupView,
  PostgresClusterView,
  PostgresDatabaseView,
  PostgresRestorePoint,
} from "../postgres.js";
import { mockReplicasJob } from "./catalog.js";
import { DAY, HOUR, MOCK_NOW, isoAgo } from "./time.js";

const checkedAt = new Date(MOCK_NOW).toISOString();

export const mockPostgresCluster: PostgresClusterView = {
  operator: "installed",
  barmanCloud: "installed",
  state: "ready",
  namespace: "postgres",
  name: "console-postgres",
  phase: "Cluster in healthy state",
  version: "17.6",
  instances: 2,
  readyInstances: 2,
  instanceList: [
    { pod: "console-postgres-1", node: "node-a", role: "primary", ready: true },
    { pod: "console-postgres-2", node: "node-b", role: "replica", ready: true },
  ],
  storageClass: "longhorn",
  size: "10Gi",
  previous: [],
  checkedAt,
};

export const mockPostgresClusterAbsent: PostgresClusterView = {
  operator: "absent",
  barmanCloud: "absent",
  state: "absent",
  namespace: "postgres",
  instances: 0,
  readyInstances: 0,
  instanceList: [],
  previous: [],
  checkedAt,
};

// After a restore: the apps moved to the recovered cluster, the old one is kept.
export const mockPostgresClusterRestored: PostgresClusterView = {
  ...mockPostgresCluster,
  name: "console-postgres-r202610061042",
  instanceList: [
    { pod: "console-postgres-r202610061042-1", node: "node-b", role: "primary", ready: true },
    { pod: "console-postgres-r202610061042-2", node: "node-a", role: "replica", ready: true },
  ],
  previous: [{ name: "console-postgres", hibernated: true, createdAt: isoAgo(30 * DAY) }],
};

export const mockPostgresDatabases: PostgresDatabaseView[] = [
  {
    database: "authentik",
    role: "authentik",
    appId: "authentik",
    secret: { namespace: "authentik", name: "authentik-postgres" },
    applied: true,
    sizeBytes: 48 * 2 ** 20,
    connections: 9,
  },
  {
    database: "grafana",
    role: "grafana",
    appId: "grafana",
    secret: { namespace: "monitoring", name: "grafana-postgres" },
    applied: false,
    message: 'role "grafana" is being created',
  },
];

export const mockPostgresRestorePoints: PostgresRestorePoint[] = [
  { id: "console-postgres-20261007020000", kind: "base-backup", at: isoAgo(10 * HOUR), state: "completed" },
  { id: "console-postgres-20261006020000", kind: "base-backup", at: isoAgo(DAY + 10 * HOUR), state: "completed" },
  {
    id: "console-postgres-20261005020000",
    kind: "base-backup",
    at: isoAgo(2 * DAY + 10 * HOUR),
    state: "failed",
    message: "can't connect to the object store: InvalidAccessKeyId",
  },
];

// Point-in-time to the S3 mock storage target (mockS3Target, "cn_st2").
export const mockPostgresBackups: PostgresBackupView = {
  method: "pitr",
  reason: "MinIO bucket is object storage: base backups and every WAL segment, restore to any moment.",
  connectorId: "cn_st2",
  targetName: "MinIO",
  protocol: "s3",
  destination: "s3://backups/cluster/postgres/",
  schedule: "0 2 * * *",
  retention: 14,
  status: "ok",
  detail: "WAL archived 40 seconds ago; last base backup 10 hours ago",
  firstRecoverabilityPoint: isoAgo(14 * DAY),
  lastBaseBackup: isoAgo(10 * HOUR),
  lastFailedBackup: {
    at: isoAgo(2 * DAY + 10 * HOUR),
    message: "can't connect to the object store: InvalidAccessKeyId",
  },
  archiving: { ok: true },
  walArchiveLagSeconds: 40,
  restorePoints: mockPostgresRestorePoints,
  checkedAt,
};

// Nightly dumps through Longhorn to the NFS mock storage target ("cn_st1").
export const mockPostgresDumpBackups: PostgresBackupView = {
  method: "dump",
  reason:
    "NAS backups is an NFS export, which takes no WAL archive: nightly dumps onto a Longhorn volume that Longhorn backs up there. Restore to the moment of a dump.",
  connectorId: "cn_st1",
  targetName: "NAS backups",
  protocol: "nfs",
  destination: "postgres/console-postgres-dumps",
  schedule: "0 2 * * *",
  retention: 14,
  status: "ok",
  detail: "Last dump 10 hours ago",
  lastDump: { at: isoAgo(10 * HOUR), ok: true },
  restorePoints: [
    { id: "console-postgres-dump-29330520", kind: "dump", at: isoAgo(10 * HOUR), state: "completed" },
    { id: "console-postgres-dump-29329080", kind: "dump", at: isoAgo(DAY + 10 * HOUR), state: "completed" },
  ],
  checkedAt,
};

export const mockPostgresBackupsOff: PostgresBackupView = {
  method: "none",
  reason: "Not backed up. Pick a storage target: S3/MinIO for point-in-time restore, NFS or SMB for nightly dumps.",
  status: "warn",
  detail: "The shared Postgres has no backups",
  restorePoints: [],
  checkedAt,
};

// Postgres actions: deploy actions on release "postgres".
const postgresJob = (id: string, action: NonNullable<DeployJobView["action"]>): DeployJobView => ({
  ...mockReplicasJob,
  id,
  appId: "postgres",
  release: "postgres",
  namespace: "postgres",
  action,
  job: { namespace: "console", name: `deploy-postgres-${id.slice(3)}` },
});

export const mockPgDatabaseJob = postgresJob("dj_31", "pg-database");
export const mockPgBackupsJob = postgresJob("dj_32", "pg-backups");
export const mockPgBackupNowJob = postgresJob("dj_33", "pg-backup-now");
export const mockPgRestoreJob = postgresJob("dj_34", "pg-restore");

// Restore to yesterday 10:42 into a new cluster.
export const mockPgRestorePlan: DeployActionPlan = {
  kind: "pg-restore",
  title: "Restore Postgres to 2026-10-06 10:42 UTC",
  allowed: true,
  steps: [
    {
      label: "Recover console-postgres-r202610061042 from the archive to 10:42",
      commands: [
        "kubectl apply -f /values/cluster.yaml",
        "kubectl wait clusters.postgresql.cnpg.io/console-postgres-r202610061042 --namespace postgres --for=condition=Ready --timeout=60m",
      ],
    },
    {
      label: "Point authentik and grafana at it and restart them",
      commands: [
        "kubectl apply -f /values/secrets.yaml",
        "kubectl rollout restart deployment --namespace authentik --selector app.kubernetes.io/instance=authentik",
        "kubectl rollout restart deployment --namespace monitoring --selector app.kubernetes.io/instance=grafana",
      ],
    },
    {
      label: "Stop console-postgres, keeping its volumes",
      commands: [
        "kubectl annotate clusters.postgresql.cnpg.io/console-postgres --namespace postgres cnpg.io/hibernation=on --overwrite",
      ],
    },
  ],
  downtime: "Authentik and Grafana restart once, onto the recovered data.",
  rollback: "Until the apps are re-pointed nothing they use changes; afterwards console-postgres is kept, stopped.",
  changes: [
    { kind: "Secret", name: "authentik-postgres", namespace: "authentik" },
    { kind: "Secret", name: "grafana-postgres", namespace: "monitoring" },
    { kind: "Cluster", name: "console-postgres", namespace: "postgres" },
  ],
  creates: [
    { kind: "Cluster", name: "console-postgres-r202610061042", namespace: "postgres" },
    { kind: "Job", name: "deploy-postgres-34", namespace: "console" },
    { kind: "Secret", name: "deploy-postgres-values", namespace: "console" },
  ],
  warnings: ["Anything written after 10:42 is not in the restored databases; console-postgres keeps it."],
};

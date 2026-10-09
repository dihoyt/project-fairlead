import type { StorageTargetView } from "../../../contracts/connectors.js";
import { deployedLabel } from "../../../contracts/deployed.js";
import { RESOURCES, type K8sApi, type KubeObject } from "../../../contracts/k8s.js";
import { POSTGRES_NAMESPACE, pgClusterName } from "../../../contracts/postgres.js";
import { product } from "../../../product.js";
import { GROUP_LABEL_PREFIX } from "./longhorn-objects.js";
import { CNPG_API, type CnpgCluster } from "./pg-objects.js";

// The objects behind the shared cluster's backups. pitr: an ObjectStore
// (Barman Cloud plugin) the Cluster archives its WAL to, under a server name
// equal to the cluster's, and a ScheduledBackup of base backups. dump: a
// CronJob running pg_dumpall onto a Longhorn claim in the "critical" group.
// Names are fixed per install, not per cluster, so a restore moves them to
// the new cluster instead of leaving a second set behind.

export const BARMAN_API = "barmancloud.cnpg.io/v1";
export const BARMAN_PLUGIN = "barman-cloud.cloudnative-pg.io";
const base = pgClusterName(product.slug);
export const STORE_NAME = `${base}-store`;
export const SCHEDULE_NAME = `${base}-backups`;
export const DUMP_NAME = `${base}-dump`;
export const DUMPS_CLAIM = `${base}-dumps`;
export const DUMPS_DIR = "/dumps";
export const CRITICAL_GROUP = "critical";
export const DEFAULT_SCHEDULE = "0 2 * * *";
export const DEFAULT_RETENTION = 14;
// The postgres image's user.
const POSTGRES_UID = 26;

const labels = () => ({ "app.kubernetes.io/managed-by": product.ownerMarker.labelDomain, ...deployedLabel() });

export const superuserSecret = (cluster: string) => `${cluster}-superuser`;

// "s3://backups@us-east-1/cluster-a/" -> "s3://backups/cluster-a/postgres/":
// Barman takes the bucket without the region, which comes from the endpoint.
export function archivePath(target: Pick<StorageTargetView, "url">): string | undefined {
  const m = /^s3:\/\/([^@/]+)(?:@[^/]*)?\/?(.*)$/.exec(target.url);
  if (!m) return undefined;
  const prefix = m[2]!.replace(/^\/+|\/+$/g, "");
  return `s3://${m[1]}/${prefix ? `${prefix}/` : ""}postgres/`;
}

export function objectStore(
  path: string,
  endpoint: string | undefined,
  credentials: string,
  retentionDays: number
): KubeObject {
  const key = (k: string) => ({ name: credentials, key: k });
  return {
    apiVersion: BARMAN_API,
    kind: "ObjectStore",
    metadata: { name: STORE_NAME, namespace: POSTGRES_NAMESPACE, labels: labels() },
    spec: {
      retentionPolicy: `${retentionDays}d`,
      configuration: {
        destinationPath: path,
        ...(endpoint ? { endpointURL: endpoint } : {}),
        s3Credentials: { accessKeyId: key("AWS_ACCESS_KEY_ID"), secretAccessKey: key("AWS_SECRET_ACCESS_KEY") },
        wal: { compression: "gzip" },
        data: { compression: "gzip" },
      },
    },
  } as KubeObject;
}

// The Cluster's plugins list with the archiver on (for a merge patch, which
// replaces the list) under the cluster's own server name.
export const archiverPlugins = (cluster: string) => [
  { name: BARMAN_PLUGIN, isWALArchiver: true, parameters: { barmanObjectName: STORE_NAME, serverName: cluster } },
];

// Five-field cron to the operator's six (seconds first).
export const sixField = (cron: string) => `0 ${cron}`;
export const fiveField = (cron: string) => cron.trim().split(/\s+/).slice(-5).join(" ");

export function scheduledBackup(cluster: string, cron: string): KubeObject {
  return {
    apiVersion: CNPG_API,
    kind: "ScheduledBackup",
    metadata: { name: SCHEDULE_NAME, namespace: POSTGRES_NAMESPACE, labels: labels() },
    spec: {
      schedule: sixField(cron),
      // A base backup now, so there is a recoverability point from the start.
      immediate: true,
      backupOwnerReference: "self",
      cluster: { name: cluster },
      method: "plugin",
      pluginConfiguration: { name: BARMAN_PLUGIN },
    },
  } as KubeObject;
}

export function baseBackup(cluster: string, name: string): KubeObject {
  return {
    apiVersion: CNPG_API,
    kind: "Backup",
    metadata: { name, namespace: POSTGRES_NAMESPACE, labels: labels() },
    spec: { cluster: { name: cluster }, method: "plugin", pluginConfiguration: { name: BARMAN_PLUGIN } },
  } as KubeObject;
}

// Longhorn copies recurring-job labels from a claim to its volume when the
// claim carries the source label.
export function dumpsClaim(size: string): KubeObject {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: DUMPS_CLAIM,
      namespace: POSTGRES_NAMESPACE,
      labels: {
        ...labels(),
        "recurring-job.longhorn.io/source": "enabled",
        [`${GROUP_LABEL_PREFIX}${CRITICAL_GROUP}`]: "enabled",
      },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: "longhorn",
      resources: { requests: { storage: size } },
    },
  } as KubeObject;
}

// Each dump is named after its Job, so a restore point (a Job) names its
// file; the newest `KEEP` files stay, as the CronJob keeps as many Jobs.
// Role passwords stay out: a restore sets new ones.
export const DUMP_SCRIPT = [
  "set -euo pipefail",
  `out="${DUMPS_DIR}/$JOB.sql.gz"`,
  'pg_dumpall --clean --if-exists --no-role-passwords | gzip > "$out.tmp"',
  'mv "$out.tmp" "$out"',
  `ls -1t ${DUMPS_DIR}/*.sql.gz | tail -n +$((KEEP + 1)) | while read -r old; do rm -f -- "$old"; done`,
  'echo "Dumped $(wc -c < "$out") bytes to $out"',
].join("\n");

// Loads one dump into a new cluster. Errors from objects the new cluster
// already has (the superuser, the operator's own roles) don't stop it.
export const LOAD_SCRIPT = [
  "set -euo pipefail",
  `in="${DUMPS_DIR}/$DUMP.sql.gz"`,
  'test -f "$in" || { echo "No dump $in" >&2; exit 1; }',
  'gunzip -c "$in" | psql --quiet --file=-',
  'echo "Loaded $in"',
].join("\n");

function postgresPod(cluster: string, image: string, script: string, env: Array<Record<string, unknown>>) {
  return {
    restartPolicy: "Never",
    securityContext: {
      runAsNonRoot: true,
      runAsUser: POSTGRES_UID,
      runAsGroup: POSTGRES_UID,
      fsGroup: POSTGRES_UID,
      seccompProfile: { type: "RuntimeDefault" },
    },
    containers: [
      {
        name: "postgres",
        image,
        command: ["/bin/bash", "-c", script],
        env: [
          { name: "PGHOST", value: `${cluster}-rw` },
          { name: "PGUSER", value: "postgres" },
          { name: "PGPASSWORD", valueFrom: { secretKeyRef: { name: superuserSecret(cluster), key: "password" } } },
          ...env,
        ],
        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
        volumeMounts: [{ name: "dumps", mountPath: DUMPS_DIR }],
        resources: { requests: { cpu: "50m", memory: "128Mi" }, limits: { memory: "512Mi" } },
      },
    ],
    volumes: [{ name: "dumps", persistentVolumeClaim: { claimName: DUMPS_CLAIM } }],
  };
}

export function dumpCronJob(cluster: string, image: string, cron: string, keep: number): KubeObject {
  return {
    apiVersion: "batch/v1",
    kind: "CronJob",
    metadata: { name: DUMP_NAME, namespace: POSTGRES_NAMESPACE, labels: labels() },
    spec: {
      schedule: cron,
      concurrencyPolicy: "Forbid",
      successfulJobsHistoryLimit: keep,
      failedJobsHistoryLimit: 3,
      jobTemplate: {
        metadata: { labels: labels() },
        spec: {
          backoffLimit: 1,
          activeDeadlineSeconds: 3600,
          template: {
            metadata: { labels: labels() },
            spec: postgresPod(cluster, image, DUMP_SCRIPT, [
              { name: "KEEP", value: String(keep) },
              {
                name: "JOB",
                valueFrom: { fieldRef: { fieldPath: "metadata.labels['batch.kubernetes.io/job-name']" } },
              },
            ]),
          },
        },
      },
    },
  } as KubeObject;
}

export function loadJob(name: string, cluster: string, image: string, dump: string): KubeObject {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace: POSTGRES_NAMESPACE, labels: labels() },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 3600,
      ttlSecondsAfterFinished: 7 * 86_400,
      template: {
        metadata: { labels: labels() },
        spec: postgresPod(cluster, image, LOAD_SCRIPT, [{ name: "DUMP", value: dump }]),
      },
    },
  } as KubeObject;
}

export interface CronJob extends KubeObject {
  spec?: {
    schedule?: string;
    successfulJobsHistoryLimit?: number;
    jobTemplate?: { spec?: { template?: { spec?: { containers?: Array<{ image?: string }> } } } };
  };
  status?: { lastScheduleTime?: string; lastSuccessfulTime?: string };
}

export interface BatchJob extends KubeObject {
  spec?: { template?: { spec?: { containers?: Array<{ env?: Array<{ name?: string; value?: string }> }> } } };
  status?: {
    startTime?: string;
    completionTime?: string;
    succeeded?: number;
    failed?: number;
    active?: number;
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
  };
}

export interface ScheduledBackup extends KubeObject {
  spec?: { schedule?: string; cluster?: { name?: string } };
}

export interface ObjectStore extends KubeObject {
  spec?: {
    retentionPolicy?: string;
    configuration?: { destinationPath?: string; endpointURL?: string };
  };
  status?: {
    serverRecoveryWindow?: Record<
      string,
      { firstRecoverabilityPoint?: string; lastSuccessfulBackupTime?: string; lastFailedBackupTime?: string }
    >;
  };
}

export const archiver = (cluster: CnpgCluster) =>
  cluster.spec?.plugins?.find((p) => p.name === BARMAN_PLUGIN && p.isWALArchiver);

// The cluster's image for the dump Jobs: the one it runs, so pg_dumpall
// matches the server's version.
export const imageOf = (cluster: CnpgCluster) =>
  (cluster.status as { image?: string } | undefined)?.image ?? cluster.spec?.imageName;

// What is set up now: the archiver on the Cluster decides pitr, the dump
// CronJob dump.
export interface BackupObjects {
  method: "pitr" | "dump" | "none";
  store?: ObjectStore;
  schedule?: ScheduledBackup;
  cron?: CronJob;
  // Barman Cloud's CRDs are served.
  barman: boolean;
}

export async function readBackupObjects(k8s: K8sApi, cluster: CnpgCluster): Promise<BackupObjects> {
  const namespace = POSTGRES_NAMESPACE;
  const [stores, schedules, crons] = await Promise.all([
    k8s.list<ObjectStore>(RESOURCES.barmanObjectStores, { namespace }),
    k8s.list<ScheduledBackup>(RESOURCES.cnpgScheduledBackups, { namespace }),
    k8s.list<CronJob>(RESOURCES.cronJobs, { namespace }),
  ]);
  const store = stores === "absent" ? undefined : stores.find((s) => s.metadata.name === STORE_NAME);
  const schedule = schedules === "absent" ? undefined : schedules.find((s) => s.metadata.name === SCHEDULE_NAME);
  const cron = crons === "absent" ? undefined : crons.find((c) => c.metadata.name === DUMP_NAME);
  const method = archiver(cluster) ? "pitr" : cron ? "dump" : "none";
  return {
    method,
    barman: stores !== "absent",
    ...(store ? { store } : {}),
    ...(schedule ? { schedule } : {}),
    ...(cron ? { cron } : {}),
  };
}

// The dump Jobs, newest first: the CronJob's own and those started from it.
export async function dumpJobs(k8s: K8sApi): Promise<BatchJob[]> {
  const jobs = await k8s.list<BatchJob>(RESOURCES.jobs, { namespace: POSTGRES_NAMESPACE });
  if (jobs === "absent") return [];
  return jobs
    .filter((j) => j.metadata.name.startsWith(`${DUMP_NAME}-`))
    .toSorted((a, b) => started(b).localeCompare(started(a)));
}

const started = (j: BatchJob) => j.status?.startTime ?? j.metadata.creationTimestamp ?? "";

export const jobSucceeded = (j: BatchJob) =>
  (j.status?.succeeded ?? 0) > 0 || !!j.status?.conditions?.some((c) => c.type === "Complete" && c.status === "True");
export const jobFailed = (j: BatchJob) =>
  !!j.status?.conditions?.some((c) => c.type === "Failed" && c.status === "True");

// "20261006T104200Z"-style stamp for names: digits only, to the minute or second.
export const stamp = (at: Date, seconds = false) =>
  at
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, seconds ? 14 : 12);

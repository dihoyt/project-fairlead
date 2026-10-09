import { randomBytes } from "node:crypto";
import type { PgRemoveClusterAction, PgRestoreAction, PlannedObject } from "../../../contracts/deploy.js";
import { RESOURCES, type KubeObject } from "../../../contracts/k8s.js";
import {
  POSTGRES_NAMESPACE,
  pgAppLabel,
  pgClusterName,
  pgSecretAnnotation,
  pgSecretName,
} from "../../../contracts/postgres.js";
import { product } from "../../../product.js";
import { toYaml } from "../yaml.js";
import type { ActionContext, ActionRecipe, ActionRendered } from "./index.js";
import { blockedAction } from "./migrate.js";
import {
  BARMAN_PLUGIN,
  DUMP_NAME,
  DEFAULT_RETENTION,
  DEFAULT_SCHEDULE,
  SCHEDULE_NAME,
  STORE_NAME,
  archiver,
  archiverPlugins,
  dumpCronJob,
  dumpJobs,
  fiveField,
  imageOf,
  jobSucceeded,
  loadJob,
  readBackupObjects,
  scheduledBackup,
  stamp,
  type ObjectStore,
} from "./pg-backup-objects.js";
import { Program, apply, remove } from "./pg-backups.js";
import {
  CLUSTER_LABEL,
  databaseFile,
  databaseObjects,
  databaseSteps,
  listOf,
  postgresBase,
  sharedCluster,
  type CnpgCluster,
  type SharedPostgres,
} from "./pg-objects.js";

// A restore never touches the cluster the apps use until the new one is
// ready: a new Cluster (recovered to a moment, or initialised and loaded
// from a dump), each app's role and database made on it with a new
// password, the app's Secret pointed there, the app restarted, backups
// moved over, and only then the old cluster labelled previous and
// hibernated, volumes kept.

const RESTORE = "pg-restore";
const REMOVE = "pg-remove-cluster";
const CLUSTERS = "clusters.postgresql.cnpg.io";
const MASKED = "********";
const READY_WAIT = "60m";
const LOAD_WAIT = "60m";
const HIBERNATION = "cnpg.io/hibernation";
const APP_LABEL = pgAppLabel(product.ownerMarker.labelDomain);
const SECRET_ANNOTATION = pgSecretAnnotation(product.ownerMarker.labelDomain);
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
// Recovery replays the WAL up to the moment; the Job waits for it.
const RESTORE_DEADLINE = 3 * 3600;

interface CnpgDatabase extends KubeObject {
  spec?: { cluster?: { name?: string } };
}

interface AppDatabase {
  appId: string;
  namespace: string;
}

// The apps with a database on `cluster` that this product made.
async function appDatabases(ctx: ActionContext, cluster: string): Promise<AppDatabase[]> {
  const listed = await ctx.k8s!.list<CnpgDatabase>(RESOURCES.cnpgDatabases, { namespace: POSTGRES_NAMESPACE });
  if (listed === "absent") return [];
  return listed
    .filter((db) => db.spec?.cluster?.name === cluster && db.metadata.labels?.[APP_LABEL])
    .map((db) => ({
      appId: db.metadata.labels![APP_LABEL]!,
      namespace: (db.metadata.annotations?.[SECRET_ANNOTATION] ?? "").split("/")[0] || db.metadata.labels![APP_LABEL]!,
    }))
    .toSorted((a, b) => a.appId.localeCompare(b.appId));
}

// The current cluster's spec without what makes it itself: how it was
// bootstrapped and where it archives.
function specLike(cluster: CnpgCluster): Record<string, unknown> {
  const { bootstrap: _b, externalClusters: _e, plugins: _p, ...spec } = (cluster.spec ?? {}) as Record<string, unknown>;
  return spec;
}

function newCluster(current: CnpgCluster, name: string, extra: Record<string, unknown>): KubeObject {
  const labels = Object.fromEntries(
    Object.entries(current.metadata.labels ?? {}).filter(([key]) => key !== CLUSTER_LABEL)
  );
  return {
    apiVersion: current.apiVersion ?? "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: { name, namespace: POSTGRES_NAMESPACE, labels },
    spec: { ...specLike(current), ...extra },
  } as KubeObject;
}

const minute = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

export const pgRestoreAction: ActionRecipe<PgRestoreAction> = {
  kind: RESTORE,

  async render(request, ctx): Promise<ActionRendered> {
    let title = "Restore Postgres";
    const found = await sharedCluster(RESTORE, title, ctx);
    if ("refused" in found) return found.refused;
    const base = postgresBase(ctx);
    const blocked = (why: string) => blockedAction(RESTORE, title, base, why);
    const current = found.cluster;
    const old = current.metadata.name;
    const k8s = ctx.k8s!;
    const backups = await readBackupObjects(k8s, current);
    if (backups.method === "none") return blocked("Postgres has no backups to restore from.");
    if ((request.at === undefined) === (request.dumpId === undefined)) {
      return blocked("Give exactly one of a moment (at) or a dump (dumpId).");
    }
    if (backups.method === "pitr" && request.at === undefined) {
      return blocked("Backups are point-in-time: give the moment to restore to (at).");
    }
    if (backups.method === "dump" && request.dumpId === undefined) {
      return blocked("Backups are dumps: give the dump to restore (dumpId).");
    }

    const clusters = await k8s.list<CnpgCluster>(RESOURCES.cnpgClusters, { namespace: POSTGRES_NAMESPACE });
    const taken = new Set(clusters === "absent" ? [] : clusters.map((c) => c.metadata.name));
    const nameFor = (at: Date) => {
      const stem = `${pgClusterName(product.slug)}-r${stamp(at)}`;
      let name = stem;
      for (let n = 2; taken.has(name); n++) name = `${stem}-${n}`;
      return name;
    };

    const program = new Program();
    const files: Record<string, string> = {};
    const secrets: string[] = [];
    const creates: PlannedObject[] = [];
    const changes: PlannedObject[] = [];
    let name: string;
    let moment: string;

    if (backups.method === "pitr") {
      const at = new Date(request.at!);
      if (Number.isNaN(at.getTime())) return blocked(`"${request.at}" is not a moment (ISO-8601).`);
      const plugin = archiver(current);
      const serverName = plugin?.parameters?.serverName ?? old;
      const store = backups.store as ObjectStore | undefined;
      const window = store?.status?.serverRecoveryWindow?.[serverName];
      const first = window?.firstRecoverabilityPoint;
      if (!first) return blocked("There is no base backup yet, so no moment to restore to.");
      if (at.getTime() < new Date(first).getTime()) {
        return blocked(`The earliest moment to restore to is ${first}.`);
      }
      if (at.getTime() > Date.now()) return blocked("That moment is in the future.");
      moment = at.toISOString();
      title = `Restore Postgres to ${minute(moment)}`;
      name = nameFor(at);
      files["cluster.yaml"] = toYaml(
        listOf([
          newCluster(current, name, {
            bootstrap: { recovery: { source: "origin", recoveryTarget: { targetTime: moment } } },
            externalClusters: [
              {
                name: "origin",
                plugin: { name: BARMAN_PLUGIN, parameters: { barmanObjectName: STORE_NAME, serverName } },
              },
            ],
            plugins: archiverPlugins(name),
          }),
        ])
      );
      program.add(`Recover ${name} from the archive to ${minute(moment)}`, apply("cluster.yaml"), readyWait(name));
    } else {
      const dumpId = request.dumpId!;
      if (!DNS_LABEL.test(dumpId)) return blocked(`"${dumpId}" is not a dump.`);
      const job = (await dumpJobs(k8s)).find((j) => j.metadata.name === dumpId);
      if (!job || !jobSucceeded(job)) return blocked(`No finished dump "${dumpId}".`);
      moment = job.status?.completionTime ?? job.status?.startTime ?? new Date().toISOString();
      title = `Restore Postgres to the dump of ${minute(moment)}`;
      const image = imageOf(current);
      if (!image) return blocked(`${old} reports no image to load the dump with.`);
      name = nameFor(new Date());
      files["cluster.yaml"] = toYaml(listOf([newCluster(current, name, {})]));
      files["load.yaml"] = toYaml(listOf([loadJob(`${name}-load`, name, image, dumpId)]));
      program.add(`Make ${name}`, apply("cluster.yaml"), readyWait(name));
      program.add(`Load ${dumpId} into it`, apply("load.yaml"), {
        argv: [
          "kubectl",
          "wait",
          `job/${name}-load`,
          "--namespace",
          POSTGRES_NAMESPACE,
          "--for=condition=Complete",
          `--timeout=${LOAD_WAIT}`,
        ],
      });
      creates.push({ kind: "Job", name: `${name}-load`, namespace: POSTGRES_NAMESPACE });
    }
    creates.push({ kind: "Cluster", name, namespace: POSTGRES_NAMESPACE });

    const pg: SharedPostgres = { namespace: POSTGRES_NAMESPACE, cluster: name };
    const apps = await appDatabases(ctx, old);
    for (const app of apps) {
      const password = ctx.run ? randomBytes(24).toString("base64url") : MASKED;
      if (ctx.run) {
        files[databaseFile(app.appId)] = toYaml(listOf(databaseObjects(pg, app.appId, app.namespace, password)));
        secrets.push(password);
      }
      program.add(
        `Give ${app.appId} its role and database on ${name} and point it there`,
        ...databaseSteps(pg, app.appId)
      );
      creates.push(
        { kind: "DatabaseRole", name: `${name}-${app.appId}`.slice(0, 63), namespace: POSTGRES_NAMESPACE },
        { kind: "Database", name: `${name}-${app.appId}`.slice(0, 63), namespace: POSTGRES_NAMESPACE }
      );
      changes.push({ kind: "Secret", name: pgSecretName(app.appId), namespace: app.namespace });
    }
    if (apps.length > 0) {
      program.add(
        `Restart ${apps.map((a) => a.appId).join(" and ")} onto it`,
        ...apps.map((app) => ({
          argv: [
            "kubectl",
            "rollout",
            "restart",
            "deployment",
            "--namespace",
            app.namespace,
            "--selector",
            `app.kubernetes.io/instance=${releaseOf(ctx, app.appId)}`,
          ],
        }))
      );
    }

    if (backups.method === "pitr") {
      const cron = backups.schedule?.spec?.schedule ? fiveField(backups.schedule.spec.schedule) : DEFAULT_SCHEDULE;
      files["schedule.yaml"] = toYaml(listOf([scheduledBackup(name, cron)]));
      program.add(
        `Take ${name}'s base backups on "${cron}"`,
        remove("scheduledbackups.postgresql.cnpg.io", SCHEDULE_NAME),
        apply("schedule.yaml")
      );
      changes.push({ kind: "ScheduledBackup", name: SCHEDULE_NAME, namespace: POSTGRES_NAMESPACE });
    } else {
      const cron = backups.cron?.spec?.schedule ?? DEFAULT_SCHEDULE;
      const keep = backups.cron?.spec?.successfulJobsHistoryLimit ?? DEFAULT_RETENTION;
      files["dumps.yaml"] = toYaml(listOf([dumpCronJob(name, imageOf(current)!, cron, keep)]));
      program.add(`Dump ${name} on "${cron}"`, apply("dumps.yaml"));
      changes.push({ kind: "CronJob", name: DUMP_NAME, namespace: POSTGRES_NAMESPACE });
    }

    program.add(
      `Make ${name} the current cluster; stop ${old}, keeping its volumes`,
      label(old, "previous"),
      label(name, "current"),
      {
        argv: [
          "kubectl",
          "annotate",
          `${CLUSTERS}/${old}`,
          "--namespace",
          POSTGRES_NAMESPACE,
          `${HIBERNATION}=on`,
          "--overwrite",
        ],
      }
    );
    changes.push({ kind: "Cluster", name: old, namespace: POSTGRES_NAMESPACE });

    const appNames = apps.map((a) => a.appId).join(" and ");
    return {
      ...base,
      plan: {
        kind: RESTORE,
        title,
        allowed: true,
        steps: program.planSteps,
        ...(apps.length > 0 ? { downtime: `${appNames} restart once, onto the restored data.` } : {}),
        rollback: `Until the apps are pointed at ${name} nothing they use changes; afterwards ${old} is kept, stopped.`,
        changes,
        creates,
        warnings: [
          `Anything written after ${minute(moment)} is not in the restored databases; ${old} keeps it.`,
          ...(apps.length > 0 ? [`${appNames} get new database passwords.`] : []),
        ],
      },
      steps: program.steps,
      files,
      secrets,
      deadlineSeconds: RESTORE_DEADLINE,
    };
  },
};

function readyWait(name: string) {
  return {
    argv: [
      "kubectl",
      "wait",
      `${CLUSTERS}/${name}`,
      "--namespace",
      POSTGRES_NAMESPACE,
      "--for=condition=Ready",
      `--timeout=${READY_WAIT}`,
    ],
  };
}

function label(name: string, value: "current" | "previous") {
  return {
    argv: [
      "kubectl",
      "label",
      `${CLUSTERS}/${name}`,
      "--namespace",
      POSTGRES_NAMESPACE,
      `${CLUSTER_LABEL}=${value}`,
      "--overwrite",
    ],
  };
}

const releaseOf = (ctx: ActionContext, appId: string) => ctx.releases.find((r) => r.appId === appId)?.release ?? appId;

export const pgRemoveClusterAction: ActionRecipe<PgRemoveClusterAction> = {
  kind: REMOVE,

  async render(request, ctx): Promise<ActionRendered> {
    const title = `Delete Postgres cluster ${request.name}`;
    const found = await sharedCluster(REMOVE, title, ctx);
    if ("refused" in found) return found.refused;
    const base = postgresBase(ctx);
    const blocked = (why: string) => blockedAction(REMOVE, title, base, why);
    if (request.name === found.cluster.metadata.name) return blocked("The apps use this cluster now.");
    const k8s = ctx.k8s!;
    const clusters = await k8s.list<CnpgCluster>(RESOURCES.cnpgClusters, { namespace: POSTGRES_NAMESPACE });
    const target = clusters === "absent" ? undefined : clusters.find((c) => c.metadata.name === request.name);
    if (!target) return blocked(`No cluster "${request.name}".`);
    if (target.metadata.labels?.[CLUSTER_LABEL] !== "previous") {
      return blocked("Only a cluster a restore replaced can be deleted here.");
    }
    const program = new Program();
    const deletes: PlannedObject[] = [];
    const [databases, roles] = await Promise.all([
      k8s.list<CnpgDatabase>(RESOURCES.cnpgDatabases, { namespace: POSTGRES_NAMESPACE }),
      k8s.list<CnpgDatabase>(RESOURCES.cnpgDatabaseRoles, { namespace: POSTGRES_NAMESPACE }),
    ]);
    const of = (list: CnpgDatabase[] | "absent") =>
      list === "absent" ? [] : list.filter((o) => o.spec?.cluster?.name === request.name).map((o) => o.metadata.name);
    const dbNames = of(databases);
    const roleNames = of(roles);
    if (dbNames.length + roleNames.length > 0) {
      program.add(
        "Delete its database and role objects (the data goes with the cluster)",
        ...dbNames.map((n) => remove("databases.postgresql.cnpg.io", n)),
        ...roleNames.map((n) => remove("databaseroles.postgresql.cnpg.io", n))
      );
      deletes.push(
        ...dbNames.map((n) => ({ kind: "Database", name: n, namespace: POSTGRES_NAMESPACE })),
        ...roleNames.map((n) => ({ kind: "DatabaseRole", name: n, namespace: POSTGRES_NAMESPACE }))
      );
    }
    program.add(`Delete ${request.name} and its volumes`, {
      argv: [
        "kubectl",
        "delete",
        `${CLUSTERS}/${request.name}`,
        "--namespace",
        POSTGRES_NAMESPACE,
        "--ignore-not-found",
        "--wait=true",
        "--timeout=10m",
      ],
    });
    deletes.push({ kind: "Cluster", name: request.name, namespace: POSTGRES_NAMESPACE });
    return {
      ...base,
      plan: {
        kind: REMOVE,
        title,
        allowed: true,
        steps: program.planSteps,
        rollback: "Nothing the apps use changes.",
        changes: [],
        creates: [],
        deletes,
        warnings: [`${request.name}'s volumes are deleted with it; what only it holds is gone.`],
      },
      steps: program.steps,
      files: {},
    };
  },
};

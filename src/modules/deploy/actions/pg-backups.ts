import type {
  DeployActionKind,
  DeployActionStep,
  PgBackupNowAction,
  PgBackupsAction,
  PlannedObject,
} from "../../../contracts/deploy.js";
import { POSTGRES_NAMESPACE } from "../../../contracts/postgres.js";
import { errorMessage } from "../../../runtime/log.js";
import { VALUES_DIR, type Step } from "../apps.js";
import { display } from "../plan.js";
import { toYaml, type YamlValue } from "../yaml.js";
import type { ActionContext, ActionRecipe, ActionRendered } from "./index.js";
import { readBackupTarget } from "./longhorn-objects.js";
import { blockedAction } from "./migrate.js";
import {
  DEFAULT_RETENTION,
  DEFAULT_SCHEDULE,
  DUMPS_CLAIM,
  DUMP_NAME,
  SCHEDULE_NAME,
  STORE_NAME,
  archivePath,
  archiverPlugins,
  baseBackup,
  dumpCronJob,
  dumpsClaim,
  imageOf,
  objectStore,
  readBackupObjects,
  scheduledBackup,
  stamp,
} from "./pg-backup-objects.js";
import { listOf, postgresBase, sharedCluster, type CnpgCluster } from "./pg-objects.js";

const BACKUPS = "pg-backups";
const NOW = "pg-backup-now";
const ARCHIVE_WAIT = "10m";
const BACKUP_WAIT = "60m";
const MAX_DUMPS = 60;
// Turning the archiver on restarts each instance before it reports archiving.
const SETUP_DEADLINE = 1800;
const NOW_DEADLINE = 3900;

const CLUSTERS = "clusters.postgresql.cnpg.io";

// Collects the Job's steps beside the plan's, one plan step per label.
export class Program {
  readonly steps: Step[] = [];
  readonly planSteps: DeployActionStep[] = [];
  add(label: string, ...steps: Step[]): void {
    this.steps.push(...steps);
    this.planSteps.push({ label, commands: steps.map((s) => display(s.argv)) });
  }
}

export const apply = (file: string): Step => ({
  argv: ["kubectl", "apply", "-f", `${VALUES_DIR}/${file}`],
  dryRun: "--dry-run=client",
});

export const patchCluster = (cluster: string, file: string): Step => ({
  argv: [
    "kubectl",
    "patch",
    `${CLUSTERS}/${cluster}`,
    "--namespace",
    POSTGRES_NAMESPACE,
    "--type",
    "merge",
    "--patch-file",
    `${VALUES_DIR}/${file}`,
  ],
});

export const remove = (resource: string, name: string): Step => ({
  argv: ["kubectl", "delete", resource, name, "--namespace", POSTGRES_NAMESPACE, "--ignore-not-found"],
});

const pitrObjects = (o: { cluster: string }): PlannedObject[] => [
  { kind: "ObjectStore", name: STORE_NAME, namespace: POSTGRES_NAMESPACE },
  { kind: "ScheduledBackup", name: SCHEDULE_NAME, namespace: POSTGRES_NAMESPACE },
  { kind: "Cluster", name: o.cluster, namespace: POSTGRES_NAMESPACE },
];

const blocked = (kind: DeployActionKind, title: string, ctx: ActionContext, why: string) =>
  blockedAction(kind, title, postgresBase(ctx), why);

// Steps that take the pitr objects away: the archiver off the Cluster
// (the instances restart without the sidecar), the schedule and the store.
// Backups already in the bucket stay there.
function stopPitr(program: Program, files: Record<string, string>, cluster: string) {
  files["no-archiver.yaml"] = toYaml({ spec: { plugins: null } });
  program.add(
    "Stop WAL archiving and base backups",
    remove("scheduledbackups.postgresql.cnpg.io", SCHEDULE_NAME),
    patchCluster(cluster, "no-archiver.yaml"),
    remove("objectstores.barmancloud.cnpg.io", STORE_NAME)
  );
}

export const pgBackupsAction: ActionRecipe<PgBackupsAction> = {
  kind: BACKUPS,

  async render(request, ctx): Promise<ActionRendered> {
    let title = request.connectorId === null ? "Turn off Postgres backups" : "Set up Postgres backups";
    const found = await sharedCluster(BACKUPS, title, ctx);
    if ("refused" in found) return found.refused;
    const cluster: CnpgCluster = found.cluster;
    const name = cluster.metadata.name;
    const k8s = ctx.k8s!;
    const current = await readBackupObjects(k8s, cluster);
    const schedule = request.schedule ?? DEFAULT_SCHEDULE;
    const retention = request.retention ?? DEFAULT_RETENTION;

    const program = new Program();
    const files: Record<string, string> = {};
    const secrets: string[] = [];
    const changes: PlannedObject[] = [];
    const creates: PlannedObject[] = [];
    const deletes: PlannedObject[] = [];
    const warnings: string[] = [];
    let downtime: string | undefined;

    if (request.connectorId === null) {
      if (current.method === "none") return blocked(BACKUPS, title, ctx, "Postgres backups are already off.");
      if (current.method === "pitr") {
        stopPitr(program, files, name);
        changes.push({ kind: "Cluster", name, namespace: POSTGRES_NAMESPACE });
        deletes.push(...pitrObjects({ cluster: name }).filter((o) => o.kind !== "Cluster"));
        downtime = "Each Postgres instance restarts once, without the archiver.";
      } else {
        program.add("Stop the dumps", remove("cronjob", DUMP_NAME));
        deletes.push({ kind: "CronJob", name: DUMP_NAME, namespace: POSTGRES_NAMESPACE });
        warnings.push(`The dumps already made stay on ${POSTGRES_NAMESPACE}/${DUMPS_CLAIM} and in Longhorn's backups.`);
      }
      return {
        ...postgresBase(ctx),
        plan: {
          kind: BACKUPS,
          title,
          allowed: true,
          steps: program.planSteps,
          ...(downtime ? { downtime } : {}),
          rollback: "Set a storage target again to resume; backups already made stay where they are.",
          changes,
          creates,
          deletes,
          warnings,
        },
        steps: program.steps,
        files,
      };
    }

    if (!ctx.storageTargets) return blocked(BACKUPS, title, ctx, "Storage targets are not available.");
    const target = await ctx.storageTargets.get(request.connectorId);
    if (!target) return blocked(BACKUPS, title, ctx, `No storage target "${request.connectorId}".`);
    title = `Back up Postgres to ${target.name}`;
    if (target.status === "crit") {
      warnings.push(`${target.name}'s own reachability check is failing.`);
    }

    if (target.protocol === "s3") {
      if (!current.barman) {
        return blocked(
          BACKUPS,
          title,
          ctx,
          "Point-in-time backups need the Barman Cloud plugin; install it from the catalog first."
        );
      }
      const path = archivePath(target);
      if (!path) return blocked(BACKUPS, title, ctx, `${target.url} is not an s3:// URL.`);
      let secret;
      try {
        secret = await ctx.storageTargets.credentialsSecret(target.id, POSTGRES_NAMESPACE);
      } catch (err) {
        return blocked(BACKUPS, title, ctx, errorMessage(err));
      }
      if (!secret) return blocked(BACKUPS, title, ctx, `${target.name} has no stored credentials.`);
      if (ctx.run) {
        files["secret.json"] = JSON.stringify(secret);
        secrets.push(...Object.values(secret.stringData).filter((v) => v.length >= 4));
      }
      const objects = [
        objectStore(path, target.endpoint, secret.metadata.name, retention),
        scheduledBackup(name, schedule),
      ];
      files["store.yaml"] = toYaml(listOf(objects.slice(0, 1)));
      files["schedule.yaml"] = toYaml(listOf(objects.slice(1)));
      files["archiver.yaml"] = toYaml({ spec: { plugins: archiverPlugins(name) } } as unknown as YamlValue);

      if (current.method === "dump") {
        program.add("Stop the dumps", remove("cronjob", DUMP_NAME));
        deletes.push({ kind: "CronJob", name: DUMP_NAME, namespace: POSTGRES_NAMESPACE });
      }
      program.add(`Describe ${path} to the Barman Cloud plugin`, apply("secret.json"), apply("store.yaml"));
      if (current.method !== "pitr") {
        downtime = "Each Postgres instance restarts once to start archiving its WAL.";
      }
      program.add("Archive every WAL segment there", patchCluster(name, "archiver.yaml"), {
        argv: [
          "kubectl",
          "wait",
          `${CLUSTERS}/${name}`,
          "--namespace",
          POSTGRES_NAMESPACE,
          "--for=condition=ContinuousArchiving",
          `--timeout=${ARCHIVE_WAIT}`,
        ],
      });
      program.add(`Take a base backup now and on "${schedule}"`, apply("schedule.yaml"));
      for (const o of pitrObjects({ cluster: name })) {
        (o.kind === "Cluster" || current.store ? changes : creates).push(o);
      }
      creates.push({ kind: "Secret", name: secret.metadata.name, namespace: POSTGRES_NAMESPACE });
      return {
        ...postgresBase(ctx),
        plan: {
          kind: BACKUPS,
          title,
          allowed: true,
          steps: program.planSteps,
          ...(downtime ? { downtime } : {}),
          rollback:
            "If archiving doesn't start the job fails with the store set; pick another target, or turn backups off.",
          changes,
          creates,
          ...(deletes.length > 0 ? { deletes } : {}),
          warnings: [...warnings, `Base backups and WAL older than ${retention} days are deleted from ${target.name}.`],
        },
        steps: program.steps,
        files,
        secrets,
        deadlineSeconds: SETUP_DEADLINE,
      };
    }

    // NFS and SMB: the plugin can't write there, so dumps onto a Longhorn
    // volume that Longhorn backs up to the same target.
    const longhorn = await readBackupTarget(k8s);
    if (longhorn === "absent") {
      return blocked(
        BACKUPS,
        title,
        ctx,
        `Dumps to ${target.protocol.toUpperCase()} go through Longhorn, which is not installed.`
      );
    }
    if ((longhorn?.spec?.backupTargetURL ?? "") !== target.url) {
      return blocked(
        BACKUPS,
        title,
        ctx,
        `Dumps reach ${target.name} through Longhorn's backups: set Longhorn's backup target to ${target.name} first.`
      );
    }
    if (retention > MAX_DUMPS) return blocked(BACKUPS, title, ctx, `Keep at most ${MAX_DUMPS} dumps.`);
    const image = imageOf(cluster);
    if (!image) return blocked(BACKUPS, title, ctx, `${name} has not started yet; try again once it is ready.`);
    const size = cluster.spec?.storage?.size ?? "10Gi";
    files["dumps.yaml"] = toYaml(listOf([dumpsClaim(size), dumpCronJob(name, image, schedule, retention)]));
    if (current.method === "pitr") {
      stopPitr(program, files, name);
      changes.push({ kind: "Cluster", name, namespace: POSTGRES_NAMESPACE });
      deletes.push(...pitrObjects({ cluster: name }).filter((o) => o.kind !== "Cluster"));
      downtime = "Each Postgres instance restarts once, without the archiver.";
    }
    program.add(`Dump every database on "${schedule}", keeping ${retention}`, apply("dumps.yaml"));
    creates.push(
      { kind: "PersistentVolumeClaim", name: DUMPS_CLAIM, namespace: POSTGRES_NAMESPACE },
      { kind: "CronJob", name: DUMP_NAME, namespace: POSTGRES_NAMESPACE }
    );
    return {
      ...postgresBase(ctx),
      plan: {
        kind: BACKUPS,
        title,
        allowed: true,
        steps: program.planSteps,
        ...(downtime ? { downtime } : {}),
        rollback: "Nothing the apps use changes; delete the CronJob or turn backups off to undo.",
        changes,
        creates,
        ...(deletes.length > 0 ? { deletes } : {}),
        warnings: [
          ...warnings,
          `The dumps' volume is in Longhorn's "critical" group, which reaches ${target.name} only on that group's backup schedule.`,
          "A restore goes back to the moment of a dump, not to any moment.",
        ],
      },
      steps: program.steps,
      files,
      deadlineSeconds: SETUP_DEADLINE,
    };
  },
};

export const pgBackupNowAction: ActionRecipe<PgBackupNowAction> = {
  kind: NOW,

  async render(_request, ctx): Promise<ActionRendered> {
    const title = "Back up Postgres now";
    const found = await sharedCluster(NOW, title, ctx);
    if ("refused" in found) return found.refused;
    const name = found.cluster.metadata.name;
    const current = await readBackupObjects(ctx.k8s!, found.cluster);
    const at = stamp(new Date(), true);
    const program = new Program();
    const files: Record<string, string> = {};
    let creates: PlannedObject[];
    if (current.method === "none") return blocked(NOW, title, ctx, "Postgres backups are off; set them up first.");
    if (current.method === "pitr") {
      const backup = `${name}-${at}`.slice(0, 63);
      files["backup.yaml"] = toYaml(listOf([baseBackup(name, backup)]));
      program.add(`Take base backup ${backup}`, apply("backup.yaml"), {
        argv: [
          "kubectl",
          "wait",
          `backups.postgresql.cnpg.io/${backup}`,
          "--namespace",
          POSTGRES_NAMESPACE,
          "--for=jsonpath={.status.phase}=completed",
          `--timeout=${BACKUP_WAIT}`,
        ],
      });
      creates = [{ kind: "Backup", name: backup, namespace: POSTGRES_NAMESPACE }];
    } else {
      const job = `${DUMP_NAME}-${at.slice(0, 12)}`.slice(0, 63);
      program.add(
        `Dump every database now (${job})`,
        { argv: ["kubectl", "create", "job", job, `--from=cronjob/${DUMP_NAME}`, "--namespace", POSTGRES_NAMESPACE] },
        {
          argv: [
            "kubectl",
            "wait",
            `job/${job}`,
            "--namespace",
            POSTGRES_NAMESPACE,
            "--for=condition=Complete",
            `--timeout=${BACKUP_WAIT}`,
          ],
        }
      );
      creates = [{ kind: "Job", name: job, namespace: POSTGRES_NAMESPACE }];
    }
    return {
      ...postgresBase(ctx),
      plan: {
        kind: NOW,
        title,
        allowed: true,
        steps: program.planSteps,
        rollback: "A failed backup changes nothing; the scheduled ones carry on.",
        changes: [],
        creates,
        warnings:
          current.method === "dump"
            ? ["The dump reaches the storage target with the dumps volume's next Longhorn backup."]
            : [],
      },
      steps: program.steps,
      files,
      deadlineSeconds: NOW_DEADLINE,
    };
  },
};

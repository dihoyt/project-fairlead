import type { LonghornBackupNowAction } from "../../../contracts/deploy.js";
import { product } from "../../../product.js";
import { VALUES_DIR, type Step } from "../apps.js";
import { display } from "../plan.js";
import type { ActionRecipe, ActionRendered } from "./index.js";
import { blockedAction, newRunId } from "./migrate.js";
import {
  LONGHORN_API,
  LONGHORN_NAMESPACE,
  NOT_INSTALLED,
  longhornBase,
  readBackupTarget,
  refuse,
  unavailableMessage,
  volumeOfClaim,
} from "./longhorn-objects.js";

// One snapshot of the claim's volume, then a backup of it to the target:
// the same two objects Longhorn's UI creates.

const KIND = "longhorn-backup-now";
const BACKUP_WAIT_SECONDS = 3600;

const wait = (resource: string, jsonpath: string, timeout: string): Step => ({
  argv: [
    "kubectl",
    "wait",
    resource,
    "--namespace",
    LONGHORN_NAMESPACE,
    `--for=jsonpath=${jsonpath}`,
    `--timeout=${timeout}`,
  ],
});

export const backupNowAction: ActionRecipe<LonghornBackupNowAction> = {
  kind: KIND,

  async render(request, ctx): Promise<ActionRendered> {
    const base = longhornBase(ctx);
    const title = `Back up ${request.namespace}/${request.claim} now`;
    const refused = refuse(KIND, title, ctx);
    if (refused) return refused;
    const k8s = ctx.k8s!;
    const volume = await volumeOfClaim(k8s, request.namespace, request.claim);
    if (volume === "absent") return blockedAction(KIND, title, base, NOT_INSTALLED);
    if (!volume)
      return blockedAction(KIND, title, base, `${request.namespace}/${request.claim} is not a Longhorn volume.`);
    const target = await readBackupTarget(k8s);
    if (target === "absent") return blockedAction(KIND, title, base, NOT_INSTALLED);
    if (!target?.spec?.backupTargetURL)
      return blockedAction(KIND, title, base, "Longhorn has no backup target; set one first.");
    if (target.status?.available === false) {
      return blockedAction(
        KIND,
        title,
        base,
        `Longhorn can't reach its backup target${unavailableMessage(target) ? `: ${unavailableMessage(target)}` : "."}`
      );
    }

    const vol = volume.metadata.name;
    const name = `${product.ownerMarker.externalPrefix}now-${newRunId()}`;
    const labels = k8s.ownedLabels();
    const files: Record<string, string> = {
      "snapshot.json": JSON.stringify({
        apiVersion: LONGHORN_API,
        kind: "Snapshot",
        metadata: { name, namespace: LONGHORN_NAMESPACE, labels },
        spec: { volume: vol, createSnapshot: true, labels: {} },
      }),
      "backup.json": JSON.stringify({
        apiVersion: LONGHORN_API,
        kind: "Backup",
        metadata: {
          name,
          namespace: LONGHORN_NAMESPACE,
          labels: { ...labels, "backup-volume": vol, "backup-target": target.metadata.name },
        },
        spec: { snapshotName: name, labels: {} },
      }),
    };
    const snapshot: Step[] = [
      { argv: ["kubectl", "create", "-f", `${VALUES_DIR}/snapshot.json`] },
      wait(`snapshots.longhorn.io/${name}`, "{.status.readyToUse}=true", "5m"),
    ];
    const backup: Step[] = [
      { argv: ["kubectl", "create", "-f", `${VALUES_DIR}/backup.json`] },
      wait(`backups.longhorn.io/${name}`, "{.status.state}=Completed", `${BACKUP_WAIT_SECONDS}s`),
    ];

    return {
      ...base,
      plan: {
        kind: KIND,
        title,
        allowed: true,
        steps: [
          { label: `Snapshot volume ${vol}`, commands: snapshot.map((s) => display(s.argv)) },
          { label: `Back it up to ${target.spec.backupTargetURL}`, commands: backup.map((s) => display(s.argv)) },
        ],
        rollback: "Nothing is changed but a new snapshot and backup; delete them in Longhorn when no longer wanted.",
        changes: [],
        creates: [
          { kind: "Snapshot", name, namespace: LONGHORN_NAMESPACE },
          { kind: "Backup", name, namespace: LONGHORN_NAMESPACE },
        ],
        warnings: [],
      },
      steps: [...snapshot, ...backup, { argv: ["echo", `Backup ${name} of ${vol} completed.`] }],
      deadlineSeconds: BACKUP_WAIT_SECONDS + 600,
      files,
    };
  },
};

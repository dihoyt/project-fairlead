import type { DeployActionStep, LonghornTargetAction, PlannedObject } from "../../../contracts/deploy.js";
import { product } from "../../../product.js";
import { errorMessage } from "../../../runtime/log.js";
import { VALUES_DIR, type Step } from "../apps.js";
import { display } from "../plan.js";
import type { ActionRecipe, ActionRendered } from "./index.js";
import { blockedAction } from "./migrate.js";
import { LONGHORN_NAMESPACE, NOT_INSTALLED, longhornBase, readBackupTarget, refuse } from "./longhorn-objects.js";

// Longhorn's own default BackupTarget, pointed at a storage-target
// connector. The credential Secret comes from the connector service and
// reaches the Job only as a file.

const KIND = "longhorn-target";
const TARGET_WAIT = "5m";
const ours = (name: string | undefined) => !!name && name.startsWith(`${product.ownerMarker.externalPrefix}backup-`);

const patchStep: Step = {
  argv: [
    "kubectl",
    "patch",
    "backuptargets.longhorn.io",
    "default",
    "--namespace",
    LONGHORN_NAMESPACE,
    "--type",
    "merge",
    "--patch-file",
    `${VALUES_DIR}/patch.yaml`,
  ],
};

export const longhornTargetAction: ActionRecipe<LonghornTargetAction> = {
  kind: KIND,

  async render(request, ctx): Promise<ActionRendered> {
    const base = longhornBase(ctx);
    const clearing = request.connectorId === null;
    let title = clearing ? "Clear Longhorn's backup target" : "Set Longhorn's backup target";
    const refused = refuse(KIND, title, ctx);
    if (refused) return refused;
    const current = await readBackupTarget(ctx.k8s!);
    if (current === "absent") return blockedAction(KIND, title, base, NOT_INSTALLED);
    if (current === null) {
      return blockedAction(KIND, title, base, "Longhorn has no default BackupTarget yet; it makes one when it starts.");
    }
    const oldSecret = current.spec?.credentialSecret || undefined;

    const files: Record<string, string> = {};
    const steps: Step[] = [];
    const planSteps: DeployActionStep[] = [];
    const creates: PlannedObject[] = [];
    const changes: PlannedObject[] = [{ kind: "BackupTarget", name: "default", namespace: LONGHORN_NAMESPACE }];
    const secrets: string[] = [];
    const warnings: string[] = [];
    let url = "";
    let secretName = "";

    if (!clearing) {
      if (!ctx.storageTargets) return blockedAction(KIND, title, base, "Storage targets are not available.");
      const target = await ctx.storageTargets.get(request.connectorId!);
      if (!target) return blockedAction(KIND, title, base, `No storage target "${request.connectorId}".`);
      title = `Send Longhorn's backups to ${target.name}`;
      url = target.url;
      let secret;
      try {
        secret = await ctx.storageTargets.credentialsSecret(target.id, LONGHORN_NAMESPACE);
      } catch (err) {
        return blockedAction(KIND, title, base, errorMessage(err));
      }
      if (secret) {
        secretName = secret.metadata.name;
        if (ctx.run) {
          files["secret.json"] = JSON.stringify(secret);
          secrets.push(...Object.values(secret.stringData).filter((v) => v.length >= 4));
        }
        const step: Step = { argv: ["kubectl", "apply", "-f", `${VALUES_DIR}/secret.json`] };
        steps.push(step);
        planSteps.push({
          label: `Store the ${target.protocol.toUpperCase()} credentials for Longhorn`,
          commands: [display(step.argv)],
        });
        (oldSecret === secretName ? changes : creates).push({
          kind: "Secret",
          name: secretName,
          namespace: LONGHORN_NAMESPACE,
        });
      }
      if (target.status === "crit") {
        warnings.push(`${target.name}'s own reachability check is failing; Longhorn may not reach it either.`);
      }
    }

    files["patch.yaml"] = JSON.stringify({ spec: { backupTargetURL: url, credentialSecret: secretName } });
    steps.push(patchStep);
    planSteps.push({
      label: clearing ? "Clear the BackupTarget's URL and credentials" : `Point the BackupTarget at ${url}`,
      commands: [display(patchStep.argv)],
    });

    if (ours(oldSecret) && oldSecret !== secretName) {
      const step: Step = {
        argv: ["kubectl", "delete", "secret", oldSecret!, "--namespace", LONGHORN_NAMESPACE, "--ignore-not-found"],
      };
      steps.push(step);
      planSteps.push({ label: "Delete the previous target's credentials", commands: [display(step.argv)] });
      changes.push({ kind: "Secret", name: oldSecret!, namespace: LONGHORN_NAMESPACE });
    }

    if (!clearing) {
      const step: Step = {
        argv: [
          "kubectl",
          "wait",
          "backuptargets.longhorn.io/default",
          "--namespace",
          LONGHORN_NAMESPACE,
          "--for=jsonpath={.status.available}=true",
          `--timeout=${TARGET_WAIT}`,
        ],
      };
      steps.push(step);
      planSteps.push({ label: "Wait for Longhorn to reach it", commands: [display(step.argv)] });
    } else {
      warnings.push("Recurring backups fail until a target is set again; snapshots carry on.");
    }

    return {
      ...base,
      plan: {
        kind: KIND,
        title,
        allowed: true,
        steps: planSteps,
        rollback: clearing
          ? "Set a target again to resume backups; backups already on the old target stay there."
          : "If Longhorn can't reach the target the job fails with the target set; set another, or clear it.",
        changes,
        creates,
        warnings,
      },
      steps,
      files,
      secrets,
    };
  },
};

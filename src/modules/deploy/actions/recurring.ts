import type { DeployActionStep, LonghornRecurringAction, PlannedObject } from "../../../contracts/deploy.js";
import { RESOURCES } from "../../../contracts/k8s.js";
import { VALUES_DIR, type Step } from "../apps.js";
import { display } from "../plan.js";
import type { ActionRecipe, ActionRendered } from "./index.js";
import { blockedAction } from "./migrate.js";
import {
  LONGHORN_NAMESPACE,
  NOT_INSTALLED,
  groupLabelArgs,
  longhornBase,
  recurringJobs,
  refuse,
  volumeOfClaim,
} from "./longhorn-objects.js";

// Longhorn's RecurringJobs made to match the console's schedules, and
// volumes' group labels. Longhorn runs the jobs itself; nothing here runs
// on a schedule.

const KIND = "longhorn-recurring";

export const recurringAction: ActionRecipe<LonghornRecurringAction> = {
  kind: KIND,

  async render(request, ctx): Promise<ActionRendered> {
    const base = longhornBase(ctx);
    const title = request.schedules ? "Set Longhorn's backup schedules" : "Change volumes' backup groups";
    const refused = refuse(KIND, title, ctx);
    if (refused) return refused;
    const k8s = ctx.k8s!;
    if (!request.schedules && !request.volumes?.length) {
      return blockedAction(KIND, title, base, "Nothing to change: give schedules, volumes or both.");
    }
    const existing = await k8s.list(RESOURCES.longhornRecurringJobs, { namespace: LONGHORN_NAMESPACE });
    if (existing === "absent") return blockedAction(KIND, title, base, NOT_INSTALLED);

    const files: Record<string, string> = {};
    const steps: Step[] = [];
    const planSteps: DeployActionStep[] = [];
    const changes: PlannedObject[] = [];
    const creates: PlannedObject[] = [];
    const warnings: string[] = [];

    if (request.schedules) {
      const jobs = recurringJobs(request.schedules, k8s.ownedLabels());
      const names = new Set(jobs.map((j) => j.metadata.name));
      const have = new Set(existing.map((j) => j.metadata.name));
      if (jobs.length > 0) {
        files["recurring.json"] = JSON.stringify({ apiVersion: "v1", kind: "List", items: jobs });
        const step: Step = { argv: ["kubectl", "apply", "-f", `${VALUES_DIR}/recurring.json`] };
        steps.push(step);
        planSteps.push({
          label: request.schedules
            .map((s) =>
              [
                s.snapshotCron ? `${s.group}: snapshot ${s.snapshotCron}` : undefined,
                s.backupCron ? `${s.group}: backup ${s.backupCron}` : undefined,
              ]
                .filter(Boolean)
                .join(", ")
            )
            .filter(Boolean)
            .join("; "),
          commands: [display(step.argv)],
        });
        for (const job of jobs) {
          (have.has(job.metadata.name) ? changes : creates).push({
            kind: "RecurringJob",
            name: job.metadata.name,
            namespace: LONGHORN_NAMESPACE,
          });
        }
      }
      const stale = existing.filter((j) => k8s.isOwned(j) && !names.has(j.metadata.name)).map((j) => j.metadata.name);
      if (stale.length > 0) {
        const step: Step = {
          argv: [
            "kubectl",
            "delete",
            "recurringjobs.longhorn.io",
            ...stale,
            "--namespace",
            LONGHORN_NAMESPACE,
            "--ignore-not-found",
          ],
        };
        steps.push(step);
        planSteps.push({ label: `Remove ${stale.join(", ")}`, commands: [display(step.argv)] });
        for (const name of stale) changes.push({ kind: "RecurringJob", name, namespace: LONGHORN_NAMESPACE });
      }
      if (!request.schedules.some((s) => s.group === "default" && s.backupCron)) {
        warnings.push("No backup schedule covers the default group: volumes in no other group get no backups.");
      }
    }

    for (const v of request.volumes ?? []) {
      const volume = await volumeOfClaim(k8s, v.namespace, v.claim);
      if (volume === "absent") return blockedAction(KIND, title, base, NOT_INSTALLED);
      if (!volume) return blockedAction(KIND, title, base, `${v.namespace}/${v.claim} is not a Longhorn volume.`);
      const args = groupLabelArgs(volume.metadata.labels, v.groups);
      if (args.length === 0) continue;
      const step: Step = {
        argv: [
          "kubectl",
          "label",
          "volumes.longhorn.io",
          volume.metadata.name,
          "--namespace",
          LONGHORN_NAMESPACE,
          "--overwrite",
          ...args,
        ],
      };
      steps.push(step);
      planSteps.push({
        label: `Put ${v.namespace}/${v.claim} in ${v.groups.length ? v.groups.join(", ") : "default"}`,
        commands: [display(step.argv)],
      });
      changes.push({ kind: "Volume", name: volume.metadata.name, namespace: LONGHORN_NAMESPACE });
    }

    if (steps.length === 0) return blockedAction(KIND, title, base, "Everything is already as asked.");
    steps.push({ argv: ["echo", "Backup schedules updated."] });

    return {
      ...base,
      plan: {
        kind: KIND,
        title,
        allowed: true,
        steps: planSteps,
        rollback: "Nothing is deleted but the schedules left out; set them again to undo.",
        changes,
        creates,
        warnings,
      },
      steps,
      files,
    };
  },
};

import type { LonghornReplicaAdvice } from "../../../contracts/backups.js";
import type { LonghornReplicasAction, PlannedObject } from "../../../contracts/deploy.js";
import { RESOURCES, type KubeObject } from "../../../contracts/k8s.js";
import { VALUES_DIR, type Step } from "../apps.js";
import { display, HELM_TIMEOUT } from "../plan.js";
import { toYaml } from "../yaml.js";
import type { ActionContext, ActionRecipe, ActionRendered } from "./index.js";

const APP = "longhorn";
const NAMESPACE = "longhorn-system";
const SETTING = "default-replica-count";
const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The Setting's value written in the form it already has: Longhorn 1.10+
// keeps per-data-engine settings as JSON ({"v1":"1","v2":"1"}).
export function settingValue(current: string | undefined, replicas: number): string {
  if (current?.trim().startsWith("{")) {
    try {
      const engines = Object.keys(JSON.parse(current) as Record<string, unknown>);
      if (engines.length > 0) return JSON.stringify(Object.fromEntries(engines.map((e) => [e, String(replicas)])));
    } catch {
      // Not JSON after all: the plain form applies to every engine.
    }
  }
  return String(replicas);
}

const patch = (resource: string, name: string, namespace: string, file: string): Step => ({
  argv: [
    "kubectl",
    "patch",
    resource,
    name,
    "--namespace",
    namespace,
    "--type",
    "merge",
    "--patch-file",
    `${VALUES_DIR}/${file}`,
  ],
});

function blocked(
  base: Omit<ActionRendered, "plan" | "steps" | "files">,
  title: string,
  blockedBy: string
): ActionRendered {
  return {
    ...base,
    plan: {
      kind: "longhorn-replicas",
      title,
      allowed: false,
      blockedBy,
      steps: [],
      changes: [],
      creates: [],
      warnings: [],
    },
    steps: [],
    files: {},
  };
}

export const replicasAction: ActionRecipe<LonghornReplicasAction> = {
  kind: "longhorn-replicas",

  async render(request: LonghornReplicasAction, ctx: ActionContext): Promise<ActionRendered> {
    const advice: LonghornReplicaAdvice = await ctx.call("GET /api/longhorn/replicas");
    const ours = ctx.releases.find((r) => r.appId === APP && r.state === "succeeded");
    const namespace = ours?.namespace ?? NAMESPACE;
    const release = ours?.release ?? APP;
    const version = (ours && ctx.versions.get(ours.release)) ?? "";
    const replicas = request.replicas ?? advice.target;
    const title = `Raise Longhorn replicas to ${replicas}`;
    const base = { appId: APP, release, namespace, version };

    if (advice.state === "absent") return blocked(base, title, "Longhorn is not installed in this cluster.");
    if (advice.state === "unknown") {
      return blocked(base, title, `Longhorn's objects could not be read: ${advice.error ?? advice.detail}`);
    }
    if (!ctx.enabled) {
      return blocked(base, title, `Deploys are off.${ctx.enableHint ? ` Turn them on with: ${ctx.enableHint}` : ""}`);
    }
    if (advice.target < 2) return blocked(base, title, advice.detail);
    // The advice lists what is below its target, so that is the only count
    // it can plan for.
    if (replicas !== advice.target) {
      return blocked(
        base,
        title,
        `Replicas are raised to ${advice.target} here: the lower of 2 and the ${plural(advice.schedulableNodes, "schedulable node")}.`
      );
    }

    const steps: Step[] = [];
    const commands: { label: string; steps: Step[] }[] = [];
    const files: Record<string, string> = {};
    const changes: PlannedObject[] = [];
    const warnings: string[] = [];

    // Our own Helm release: change its values, so a later upgrade keeps the
    // count and the chart rewrites its StorageClass (Longhorn recreates it
    // from the chart's ConfigMap; StorageClass parameters can't be patched).
    const entry = ctx.catalog?.get(APP);
    const helm = ours && version && entry?.install.kind === "helm" ? entry.install : undefined;
    const settingLow = advice.defaultReplicaCount === undefined || advice.defaultReplicaCount < replicas;
    const chartClass = helm ? advice.storageClasses.find((sc) => sc.name === "longhorn") : undefined;
    const group: Step[] = [];
    if (helm && (settingLow || chartClass)) {
      const oci = helm.repo.startsWith("oci://");
      files["replicas.yaml"] = toYaml({
        defaultSettings: { defaultReplicaCount: replicas },
        persistence: { defaultClassReplicaCount: replicas },
      });
      group.push({
        argv: [
          "helm",
          "upgrade",
          release,
          oci ? `${helm.repo.replace(/\/+$/, "")}/${helm.chart}` : helm.chart,
          ...(oci ? [] : ["--repo", helm.repo]),
          "--version",
          version,
          "--namespace",
          namespace,
          "--reuse-values",
          "--values",
          `${VALUES_DIR}/replicas.yaml`,
          "--wait",
          "--timeout",
          HELM_TIMEOUT,
        ],
      });
      if (chartClass) changes.push({ kind: "StorageClass", name: chartClass.name });
    }
    if (settingLow) {
      let current: string | undefined;
      try {
        const found = await ctx.k8s?.get<KubeObject & { value?: string }>(
          RESOURCES.longhornSettings,
          SETTING,
          namespace
        );
        if (found && found !== "absent") current = found.value;
      } catch {
        // Unread: the plain form, which every Longhorn version accepts.
      }
      files["setting.yaml"] = toYaml({ value: settingValue(current, replicas) });
      group.push(patch("settings.longhorn.io", SETTING, namespace, "setting.yaml"));
      changes.push({ kind: "Setting", name: SETTING, namespace });
    }
    if (group.length > 0) {
      const what = helm ? "Longhorn's StorageClass and default replica count" : "Longhorn's default replica count";
      commands.push({ label: `Set ${what} to ${replicas}`, steps: group });
    }

    for (const sc of advice.storageClasses) {
      if (sc === chartClass) continue;
      warnings.push(
        `StorageClass ${sc.name} gives new volumes ${plural(sc.replicas, "replica")}, and a StorageClass can't be ` +
          `changed in place: recreate it with numberOfReplicas "${replicas}", or change it in whatever installed it.`
      );
    }

    const volumes = advice.volumes.filter((v) => NAME.test(v.name));
    if (request.existingVolumes && volumes.length > 0) {
      files["volume.yaml"] = toYaml({ spec: { numberOfReplicas: replicas } });
      commands.push({
        label: `Raise ${plural(volumes.length, "existing volume")} to ${replicas} replicas`,
        steps: volumes.map((v) => patch("volumes.longhorn.io", v.name, namespace, "volume.yaml")),
      });
      for (const v of volumes) changes.push({ kind: "Volume", name: v.name, namespace });
      warnings.push(
        "Each raised volume copies its data to another node; expect disk and network load while it rebuilds."
      );
    } else if (volumes.length > 0) {
      warnings.push(
        `${plural(volumes.length, "existing volume")} ${volumes.length === 1 ? "keeps" : "keep"} fewer than ${replicas} replicas.`
      );
    }

    if (commands.length === 0) {
      return blocked(
        base,
        title,
        volumes.length > 0
          ? `Only existing volumes are below ${replicas} replicas; tick them to raise them.`
          : `Nothing is below ${replicas} replicas.`
      );
    }
    for (const c of commands) steps.push(...c.steps);
    steps.push({ argv: ["echo", `Longhorn raised to ${replicas} replicas.`] });

    return {
      ...base,
      plan: {
        kind: "longhorn-replicas",
        title,
        allowed: true,
        steps: commands.map((c) => ({ label: c.label, commands: c.steps.map((s) => display(s.argv)) })),
        rollback:
          "Nothing is lowered: a failed step leaves the earlier ones raised, and running it again picks up where it stopped.",
        changes,
        creates: [],
        warnings,
      },
      steps,
      files,
    };
  },
};

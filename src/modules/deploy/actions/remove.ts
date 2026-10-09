import type { CheckView } from "../../../contracts/checks.js";
import { deployedLabel } from "../../../contracts/deployed.js";
import type { ActionVolume, PlannedObject, RemoveAppAction } from "../../../contracts/deploy.js";
import { RESOURCES, type KubeObject } from "../../../contracts/k8s.js";
import { TEMPLATE_LABEL_SUFFIX, type TemplateInstance } from "../../../contracts/templates.js";
import { product } from "../../../product.js";
import { VALUES_DIR } from "../apps.js";
import { display } from "../plan.js";
import type { ActionContext, ActionRecipe, ActionRendered } from "./index.js";

// What goes when the volumes stay: everything a template or the runner puts
// in the namespace except the namespace itself and its claims. ConfigMaps,
// Secrets and ServiceAccounts go only when they carry the deployed-by label,
// so the namespace's kube-root-ca.crt and default ServiceAccount are left be.
const KINDS = "deployment,statefulset,daemonset,job,cronjob,service,ingress,role,rolebinding";
const LABELLED_KINDS = "configmap,secret,serviceaccount";
const TIMEOUT = "5m";

// Fixed program; its inputs are files under /values. The namespace must
// still carry the template label for anything to be deleted.
export const REMOVE_SCRIPT = `set -eu
ns=$(cat ${VALUES_DIR}/namespace)
template=$(cat ${VALUES_DIR}/template-selector)
deployed=$(cat ${VALUES_DIR}/deployed-selector)
if [ -z "$(kubectl get namespace -l "$template,kubernetes.io/metadata.name=$ns" -o name)" ]; then
  if kubectl get namespace "$ns" >/dev/null 2>&1; then
    echo "Namespace $ns does not carry the label Templates gives its apps; nothing was deleted."
    exit 1
  fi
  echo "Namespace $ns was already gone."
  exit 0
fi
if [ "$(cat ${VALUES_DIR}/delete-volumes)" = "true" ]; then
  kubectl delete namespace "$ns" --wait=true --timeout=${TIMEOUT}
  echo "Removed $ns with its namespace and volumes."
else
  kubectl delete ${KINDS} --all --namespace "$ns" --ignore-not-found --wait=true --timeout=${TIMEOUT}
  kubectl delete ${LABELLED_KINDS} -l "$deployed" --namespace "$ns" --ignore-not-found --wait=true --timeout=${TIMEOUT}
  echo "Removed $ns; its namespace and volumes stay."
fi
`;

// Fixed program for a catalog app installed with Helm; inputs are files.
// PVCs from a chart's StatefulSets outlive helm uninstall, so the volumes
// are matched by the release's instance label.
export const UNINSTALL_SCRIPT = `set -eu
release=$(cat ${VALUES_DIR}/release)
ns=$(cat ${VALUES_DIR}/namespace)
if helm status "$release" --namespace "$ns" >/dev/null 2>&1; then
  helm uninstall "$release" --namespace "$ns" --wait --timeout ${TIMEOUT}
else
  echo "Release $release was not found in $ns; nothing to uninstall."
fi
if [ "$(cat ${VALUES_DIR}/delete-volumes)" = "true" ]; then
  kubectl delete pvc -l "app.kubernetes.io/instance=$release" --namespace "$ns" --ignore-not-found --wait=true --timeout=${TIMEOUT}
  echo "Uninstalled $release and deleted its volumes."
else
  echo "Uninstalled $release; its volumes stay."
fi
`;

// Everything else depends on these, so they are never removed from here.
const NOT_REMOVABLE: Record<string, string> = {
  longhorn: "Longhorn can't be uninstalled from here: every volume on it would go with it.",
};

const selector = (labels: Record<string, string>) =>
  Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

// "host:port" of an http(s) URL with its default port spelled out.
function endpointOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return undefined;
  }
}

// HTTP checks watching the instance's address, as the Templates page adds
// them, and for an external service the check on the target itself.
export function checksFor(instance: TemplateInstance, checks: readonly CheckView[]): CheckView[] {
  const hosts = new Set(
    [instance.host, instance.url ? hostOf(instance.url) : undefined].filter((h): h is string => Boolean(h))
  );
  const ext = instance.external;
  const target = ext ? `${ext.address.includes(":") ? `[${ext.address}]` : ext.address}:${ext.port}` : undefined;
  return checks.filter(
    (c) =>
      (c.kind === "http" && hosts.has(hostOf(c.target) ?? "")) ||
      (target !== undefined && (c.kind === "tcp" ? c.target === target : endpointOf(c.target) === target))
  );
}

interface Claim extends KubeObject {
  spec?: { storageClassName?: string; resources?: { requests?: { storage?: string } } };
}

export const removeAction: ActionRecipe<RemoveAppAction> = {
  kind: "remove-app",

  async render(request: RemoveAppAction, ctx: ActionContext): Promise<ActionRendered> {
    const deleteVolumes = request.deleteVolumes === true;
    const ours = ctx.releases.find((r) => r.appId === request.appId);
    const release = ours?.release ?? request.appId;
    const base = {
      appId: request.appId,
      release,
      namespace: ours?.namespace ?? request.appId,
      version: ctx.versions.get(release) ?? "",
    };
    const title = `Remove ${request.appId}`;
    const blocked = (blockedBy: string): ActionRendered => ({
      ...base,
      plan: {
        kind: "remove-app",
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
    });

    const view = await ctx.call("GET /api/templates");
    const instance = view.instances.find((i) => i.name === request.appId);
    if (!instance) {
      const entry = ctx.catalog?.get(request.appId);
      if (entry?.install.kind === "helm" && ours) return uninstall(request, ctx, base, entry.name, blocked);
      return blocked(
        `${request.appId} is not an app deployed from Templates or installed with Helm from here; only those can be removed.`
      );
    }
    const namespace = instance.namespace;
    const rendered = { ...base, namespace, version: base.version || instance.version };
    if (!ctx.enabled) {
      return blocked(`Deploys are off.${ctx.enableHint ? ` Turn them on with: ${ctx.enableHint}` : ""}`);
    }
    if (!ctx.k8s) return blocked("The cluster can't be read, so what would be deleted is unknown.");

    const templateKey = `${product.ownerMarker.labelDomain}/${TEMPLATE_LABEL_SUFFIX}`;
    const found = await ctx.k8s.get(RESOURCES.namespaces, namespace);
    if (found === "absent") return blocked("The cluster can't be read, so what would be deleted is unknown.");
    if (found && found.metadata.labels?.[templateKey] !== instance.templateId) {
      return blocked(`Namespace ${namespace} does not carry the label Templates gives its apps; nothing is removed.`);
    }

    const warnings: string[] = [];
    const deletes: PlannedObject[] = [];
    const volumes: ActionVolume[] = [];
    if (found) {
      const listed = async (ref: (typeof RESOURCES)[keyof typeof RESOURCES]) => {
        const list = await ctx.k8s!.list(ref, { namespace });
        return list === "absent" ? [] : list;
      };
      const [deployments, services, ingresses, claims] = await Promise.all([
        listed(RESOURCES.deployments),
        listed(RESOURCES.services),
        listed(RESOURCES.ingresses),
        listed(RESOURCES.pvcs) as Promise<Claim[]>,
      ]);
      for (const [kind, list] of [
        ["Deployment", deployments],
        ["Service", services],
        ["Ingress", ingresses],
      ] as const) {
        for (const obj of list) deletes.push({ kind, name: obj.metadata.name, namespace });
      }
      for (const claim of claims) {
        volumes.push({
          namespace,
          claim: claim.metadata.name,
          storageClass: claim.spec?.storageClassName ?? "",
          size: claim.spec?.resources?.requests?.storage ?? "",
        });
      }
      if (deleteVolumes) {
        for (const v of volumes) deletes.push({ kind: "PersistentVolumeClaim", name: v.claim, namespace });
        deletes.push({ kind: "Namespace", name: namespace });
        if (volumes.length > 0)
          warnings.push(`The data on ${volumes.map((v) => v.claim).join(", ")} is deleted for good.`);
      } else if (volumes.length > 0) {
        warnings.push(
          `The namespace ${namespace} and its ${volumes.length === 1 ? "volume" : "volumes"} stay: ` +
            `deploying ${instance.name} from Templates again picks the data back up.`
        );
      } else {
        warnings.push(`The namespace ${namespace} stays unless it is deleted too.`);
      }
    } else {
      warnings.push(`Namespace ${namespace} is already gone; this only forgets ${instance.name}.`);
    }

    const checks = checksFor(instance, await ctx.call("GET /api/checks").catch(() => []));
    for (const c of checks) deletes.push({ kind: "Check", name: c.label });

    const command = deleteVolumes
      ? [["kubectl", "delete", "namespace", namespace, "--wait=true", `--timeout=${TIMEOUT}`]]
      : [
          ["kubectl", "delete", KINDS, "--all", "--namespace", namespace, "--ignore-not-found"],
          ["kubectl", "delete", LABELLED_KINDS, "-l", selector(deployedLabel()), "--namespace", namespace],
        ];

    return {
      ...rendered,
      plan: {
        kind: "remove-app",
        title,
        allowed: true,
        steps: [
          ...(checks.length > 0
            ? [{ label: `Delete the check ${checks.map((c) => c.label).join(", ")}`, commands: [] }]
            : []),
          {
            label: deleteVolumes
              ? `Delete the namespace ${namespace} with everything in it, volumes included`
              : `Delete ${instance.name}'s workloads, Services and Ingresses`,
            commands: found ? command.map(display) : [],
          },
        ],
        downtime: `${instance.name} stops for good.`,
        rollback:
          deleteVolumes || volumes.length === 0
            ? `Nothing can be put back; deploy ${instance.name} again from Templates to start fresh.`
            : `Deploy ${instance.name} again from Templates; its volume is still there.`,
        changes: [],
        creates: [],
        deletes,
        warnings,
        ...(volumes.length > 0 ? { volumes } : {}),
      },
      steps: [],
      script: REMOVE_SCRIPT,
      deadlineSeconds: 600,
      files: ctx.run
        ? {
            namespace,
            "template-selector": `${templateKey}=${instance.templateId}`,
            "deployed-selector": selector(deployedLabel()),
            "delete-volumes": String(deleteVolumes),
          }
        : {},
      // The check goes as the job starts: once the app is gone it could only fail.
      onStarted: async () => {
        for (const c of checks) await ctx.call("DELETE /api/checks/:id", { params: { id: c.id } });
      },
    };
  },
};

// helm uninstall for a catalog app the deploy runner installed.
async function uninstall(
  request: RemoveAppAction,
  ctx: ActionContext,
  base: { appId: string; release: string; namespace: string; version: string },
  name: string,
  blocked: (why: string) => ActionRendered
): Promise<ActionRendered> {
  const refused = NOT_REMOVABLE[request.appId];
  if (refused) return blocked(refused);
  if (!ctx.enabled) {
    return blocked(`Deploys are off.${ctx.enableHint ? ` Turn them on with: ${ctx.enableHint}` : ""}`);
  }
  if (!ctx.k8s) return blocked("The cluster can't be read, so what would be deleted is unknown.");
  const deleteVolumes = request.deleteVolumes === true;
  const { release, namespace } = base;
  const instanceLabel = `app.kubernetes.io/instance=${release}`;
  const listed = await ctx.k8s.list(RESOURCES.pvcs, { namespace, labelSelector: instanceLabel });
  const claims = (listed === "absent" ? [] : listed) as Claim[];
  const volumes: ActionVolume[] = claims.map((claim) => ({
    namespace,
    claim: claim.metadata.name,
    storageClass: claim.spec?.storageClassName ?? "",
    size: claim.spec?.resources?.requests?.storage ?? "",
  }));
  const warnings: string[] = [];
  if (volumes.length > 0) {
    warnings.push(
      deleteVolumes
        ? `The data on ${volumes.map((v) => v.claim).join(", ")} is deleted for good.`
        : `${volumes.map((v) => v.claim).join(", ")} ${volumes.length === 1 ? "stays" : "stay"}. ` +
            `A fresh install generates new passwords, so an app that keeps its own database on them may not start against the old data.`
    );
  }
  warnings.push(`The namespace ${namespace} stays.`);
  const deletes: PlannedObject[] = [
    { kind: "HelmRelease", name: release, namespace },
    ...(deleteVolumes ? volumes.map((v) => ({ kind: "PersistentVolumeClaim", name: v.claim, namespace })) : []),
  ];
  const commands = [
    ["helm", "uninstall", release, "--namespace", namespace, "--wait", "--timeout", TIMEOUT],
    ...(deleteVolumes
      ? [["kubectl", "delete", "pvc", "-l", instanceLabel, "--namespace", namespace, "--ignore-not-found"]]
      : []),
  ];
  return {
    ...base,
    plan: {
      kind: "remove-app",
      title: `Uninstall ${name}`,
      allowed: true,
      steps: [
        {
          label: deleteVolumes
            ? `Uninstall the Helm release ${release} and delete its volumes`
            : `Uninstall the Helm release ${release}, keeping its volumes`,
          commands: commands.map(display),
        },
      ],
      downtime: `${name} stops until it is deployed again.`,
      rollback:
        deleteVolumes || volumes.length === 0
          ? `Nothing can be put back; deploy ${name} again to start fresh.`
          : `Deploy ${name} again; its volumes are still there.`,
      changes: [],
      creates: [],
      deletes,
      warnings,
      ...(volumes.length > 0 ? { volumes } : {}),
    },
    steps: [],
    script: UNINSTALL_SCRIPT,
    deadlineSeconds: 600,
    files: ctx.run ? { release, namespace, "delete-volumes": String(deleteVolumes) } : {},
  };
}

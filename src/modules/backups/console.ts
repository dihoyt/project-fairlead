import type { Request } from "express";
import type { ConsoleBackupView, ConsoleStorage } from "../../contracts/backups.js";
import type { ConsoleNightlyView, DeployJobView } from "../../contracts/deploy.js";
import { RESOURCES, type K8sApi, type KubeObject } from "../../contracts/k8s.js";
import type { ModuleContext } from "../../contracts/module.js";
import { product } from "../../product.js";
import { HttpError } from "../../runtime/http.js";
import type { ClusterPvc } from "./cluster.js";
import { readVolumes } from "./longhorn.js";

const LOCAL_PATH_PROVISIONER = "rancher.io/local-path";
const LONGHORN_PROVISIONER = "driver.longhorn.io";

interface StorageClassObject extends KubeObject {
  provisioner?: string;
}

async function storageOf(k8s: K8sApi, pvc: ClusterPvc, onLonghorn: boolean): Promise<ConsoleStorage> {
  if (onLonghorn) return "longhorn";
  if (!pvc.storageClass) return "other";
  const sc = await k8s.get<StorageClassObject>(RESOURCES.storageClasses, pvc.storageClass).catch(() => null);
  const provisioner = sc && sc !== "absent" ? sc.provisioner : undefined;
  if (provisioner === LONGHORN_PROVISIONER) return "longhorn";
  if (provisioner === LOCAL_PATH_PROVISIONER || (!provisioner && pvc.storageClass === "local-path")) {
    return "local-path";
  }
  return "other";
}

function restoreCommand(namespace: string, release: string, file?: string): string {
  return [
    "sudo ./install.sh --restore ./recovery-kit.txt",
    `--from ./${file ?? `${release}-<timestamp>.db`}`,
    `--release ${release} --namespace ${namespace}`,
  ].join(" ");
}

export function registerConsoleRoutes(
  ctx: ModuleContext,
  deps: {
    pvcs(): Promise<ClusterPvc[]>;
    runAction(req: Request, body: { kind: "console-backup" }): Promise<DeployJobView>;
    env?: NodeJS.ProcessEnv;
  }
): void {
  const env = deps.env ?? process.env;

  ctx.route("GET /api/backups/console", async (req) => {
    const namespace = env.POD_NAMESPACE || product.defaultNamespace;
    const release = env.HELM_RELEASE || product.chartName;
    const nightly: ConsoleNightlyView = await ctx.call(req, "GET /api/deploy/console-backup").catch((err: unknown) => ({
      schedule: "",
      keep: 0,
      blockedBy: err instanceof HttpError ? err.message : "The deploy module did not answer.",
    }));
    const view: ConsoleBackupView = {
      storage: "none",
      nightly,
      secretsKey: Boolean(env.SECRETS_KEY),
      restoreCommand: restoreCommand(namespace, release, nightly.lastGood?.file),
    };
    if (!ctx.services.has("k8s")) return view;
    const k8s = ctx.services.get("k8s");
    const own = (await deps.pvcs().catch(() => [])).find((pvc) => pvc.ownData);
    if (!own) return view;
    view.claim = own.ref;
    if (own.storageClass) view.storageClass = own.storageClass;
    const volumes = await readVolumes(k8s).catch(() => "absent" as const);
    const longhorn = volumes === "absent" ? undefined : volumes.byClaim.get(`${own.ref.namespace}/${own.ref.name}`);
    view.storage = await storageOf(k8s, own, !!longhorn);
    if (longhorn) {
      view.groups = longhorn.groups;
      if (longhorn.lastBackupAt) view.lastVolumeBackupAt = longhorn.lastBackupAt;
    }
    return view;
  });

  ctx.route("POST /api/backups/console/backup-now", async (req, res) => {
    if (!ctx.require(req, res, "write")) return undefined;
    return deps.runAction(req, { kind: "console-backup" });
  });
}

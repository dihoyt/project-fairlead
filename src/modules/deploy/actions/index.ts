import { z } from "zod";
import type { ApiRoutes, RouteKey } from "../../../contracts/api.js";
import type { CatalogService, DiscoveryReport } from "../../../contracts/catalog.js";
import type {
  DeployActionKind,
  DeployActionPlan,
  DeployActionRequest,
  DeployedRelease,
  DeployJobView,
} from "../../../contracts/deploy.js";
import type { StorageTargetService } from "../../../contracts/connectors.js";
import type { K8sApi } from "../../../contracts/k8s.js";
import type { CallInput } from "../../../contracts/module.js";
import type { Step } from "../apps.js";
import { backupAction } from "./backup.js";
import { gateAction, type GateActionContext } from "./gate.js";
import { backupNowAction } from "./backup-now.js";
import { longhornTargetAction } from "./longhorn-target.js";
import { migrateAction, migrateStorageAction } from "./migrate.js";
import { NODE_NAME, nodeActions } from "./node.js";
import { recurringAction } from "./recurring.js";
import { restoreAction } from "./restore.js";
import { removeAction } from "./remove.js";
import { replicasAction } from "./replicas.js";
import { portsAction } from "../ports.js";

// What an action renders from. Reads only: nothing here changes the cluster.
export interface ActionContext {
  // false for a plan, true when the action is about to run: per-run values
  // (tokens, generated names) are made only then.
  run: boolean;
  enabled: boolean;
  // The helm/kubectl image deploy Jobs run (DeployStatus.image).
  image: string;
  // Set when deploys are off: the command that turns them on.
  enableHint?: string;
  // Another module's JSON route, in-process, as the user asking.
  call<K extends RouteKey>(key: K, input?: CallInput<K>): Promise<ApiRoutes[K]["response"]>;
  k8s?: K8sApi;
  catalog?: CatalogService;
  // The catalog's discovery (cached); undefined when it failed.
  discover(): Promise<DiscoveryReport | undefined>;
  // The latest install or upgrade job per release (Deployer.releases()).
  releases: readonly DeployedRelease[];
  // Release -> the version of its latest succeeded install or upgrade.
  versions: ReadonlyMap<string, string>;
  // For app-gate; undefined without the platform's gate service.
  gate?: GateActionContext;
  // For the backup target; undefined without module connector-storage.
  storageTargets?: StorageTargetService;
}

export interface ActionRendered {
  // The runner adds the Job and its values Secret to plan.creates.
  plan: DeployActionPlan;
  // The deploy job's row: one job per release at a time, so an action takes
  // the release of the app it changes.
  appId: string;
  release: string;
  namespace: string;
  version: string;
  // Empty when the plan is not allowed.
  steps: Step[];
  // Instead of steps: a fixed program from code, run with /bin/sh -c.
  // Inputs reach it only as files under /values, never in the text.
  script?: string;
  // The Job's activeDeadlineSeconds; default 900.
  deadlineSeconds?: number;
  files: Record<string, string>;
  // A node the Job's pod must not run on: the one an action drains or reboots.
  avoidNode?: string;
  // Values the run carries that its log must never show.
  secrets?: string[];
  // Called once the Job is created, e.g. to keep a per-run token under the
  // job's id. A throw is logged; the job keeps running.
  onStarted?(job: DeployJobView): Promise<void> | void;
}

export interface ActionRecipe<R extends DeployActionRequest = DeployActionRequest> {
  kind: R["kind"];
  render(request: R, ctx: ActionContext): Promise<ActionRendered>;
}

const k8sName = z.string().min(1).max(253);
export const groupName = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/, "must be lowercase letters, digits and dashes, at most 40");
// Five fields of digits, ranges, lists, steps and *; Longhorn checks the rest.
export const cronSchema = z
  .string()
  .trim()
  .regex(/^[0-9*,/-]+( [0-9*,/-]+){4}$/, "must be a five-field cron such as 0 3 * * *");
export const scheduleSchema = z.object({
  group: groupName,
  snapshotCron: cronSchema.optional(),
  snapshotRetain: z.number().int().min(1).max(250).optional(),
  backupCron: cronSchema.optional(),
  backupRetain: z.number().int().min(1).max(250).optional(),
});

const recipes: { [K in DeployActionKind]?: ActionRecipe<Extract<DeployActionRequest, { kind: K }>> } = {
  "longhorn-replicas": replicasAction,
  "migrate-to-longhorn": migrateAction,
  "backup-volumes": backupAction,
  "remove-app": removeAction,
  "app-gate": gateAction,
  "traefik-ports": portsAction,
  ...nodeActions,
  "migrate-storage": migrateStorageAction,
  "longhorn-target": longhornTargetAction,
  "longhorn-recurring": recurringAction,
  "longhorn-backup-now": backupNowAction,
  "longhorn-restore": restoreAction,
};

export function actionRecipe<K extends DeployActionKind>(
  kind: K
): ActionRecipe<Extract<DeployActionRequest, { kind: K }>> | undefined {
  return recipes[kind];
}

const nodeName = z.string().regex(NODE_NAME).max(253);
const drainOptions = {
  ignoreDaemonSets: z.boolean().optional(),
  deleteEmptyDirData: z.boolean().optional(),
  timeoutSeconds: z.number().int().min(30).max(3600).optional(),
};

export const actionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("longhorn-replicas"),
    replicas: z.number().int().min(1).max(3).optional(),
    existingVolumes: z.boolean(),
  }),
  z.object({ kind: z.literal("migrate-to-longhorn"), appId: z.string().min(1).max(100) }),
  z.object({ kind: z.literal("backup-volumes"), appId: z.string().min(1).max(100) }),
  z.object({ kind: z.literal("remove-app"), appId: z.string().min(1).max(100), deleteVolumes: z.boolean().optional() }),
  z.object({ kind: z.literal("app-gate"), appId: z.string().min(1).max(100), public: z.boolean() }),
  z.object({ kind: z.literal("traefik-ports") }),
  z.object({ kind: z.literal("node-cordon"), node: nodeName }),
  z.object({ kind: z.literal("node-uncordon"), node: nodeName }),
  z.object({ kind: z.literal("node-drain"), node: nodeName, ...drainOptions }),
  z.object({ kind: z.literal("node-reboot"), node: nodeName, ...drainOptions }),
  z.object({
    kind: z.literal("migrate-storage"),
    appId: z.string().min(1).max(100),
    to: z.enum(["longhorn", "local-path"]),
  }),
  z.object({ kind: z.literal("longhorn-target"), connectorId: z.string().min(1).max(100).nullable() }),
  z.object({
    kind: z.literal("longhorn-recurring"),
    schedules: z.array(scheduleSchema).max(20).optional(),
    volumes: z
      .array(z.object({ namespace: k8sName, claim: k8sName, groups: z.array(groupName).max(10) }))
      .max(500)
      .optional(),
  }),
  z.object({ kind: z.literal("longhorn-backup-now"), namespace: k8sName, claim: k8sName }),
  z.object({
    kind: z.literal("longhorn-restore"),
    namespace: k8sName,
    claim: k8sName,
    backup: z.string().min(1).max(253),
    mode: z.enum(["new-pvc", "in-place"]),
    newClaim: k8sName.optional(),
  }),
]);

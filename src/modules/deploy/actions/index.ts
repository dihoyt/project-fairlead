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
import type { K8sApi } from "../../../contracts/k8s.js";
import type { CallInput } from "../../../contracts/module.js";
import type { Step } from "../apps.js";
import { backupAction } from "./backup.js";
import { gateAction, type GateActionContext } from "./gate.js";
import { migrateAction } from "./migrate.js";
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

const recipes: { [K in DeployActionKind]?: ActionRecipe<Extract<DeployActionRequest, { kind: K }>> } = {
  "longhorn-replicas": replicasAction,
  "migrate-to-longhorn": migrateAction,
  "backup-volumes": backupAction,
  "remove-app": removeAction,
  "app-gate": gateAction,
  "traefik-ports": portsAction,
};

export function actionRecipe<K extends DeployActionKind>(
  kind: K
): ActionRecipe<Extract<DeployActionRequest, { kind: K }>> | undefined {
  return recipes[kind];
}

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
]);

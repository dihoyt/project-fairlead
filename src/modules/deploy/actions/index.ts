import { z } from "zod";
import type { ApiRoutes, RouteKey } from "../../../contracts/api.js";
import type { CatalogService } from "../../../contracts/catalog.js";
import type {
  DeployActionKind,
  DeployActionPlan,
  DeployActionRequest,
  DeployedRelease,
} from "../../../contracts/deploy.js";
import type { K8sApi } from "../../../contracts/k8s.js";
import type { CallInput } from "../../../contracts/module.js";
import type { Step } from "../apps.js";
import { replicasAction } from "./replicas.js";

// What an action renders from. Reads only: nothing here changes the cluster.
export interface ActionContext {
  enabled: boolean;
  // Set when deploys are off: the command that turns them on.
  enableHint?: string;
  // Another module's JSON route, in-process, as the user asking.
  call<K extends RouteKey>(key: K, input?: CallInput<K>): Promise<ApiRoutes[K]["response"]>;
  k8s?: K8sApi;
  catalog?: CatalogService;
  // The latest install or upgrade job per release (Deployer.releases()).
  releases: readonly DeployedRelease[];
  // Release -> the version of its latest succeeded install or upgrade.
  versions: ReadonlyMap<string, string>;
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
  files: Record<string, string>;
}

export interface ActionRecipe<R extends DeployActionRequest = DeployActionRequest> {
  kind: R["kind"];
  render(request: R, ctx: ActionContext): Promise<ActionRendered>;
}

const recipes: { [K in DeployActionKind]?: ActionRecipe<Extract<DeployActionRequest, { kind: K }>> } = {
  "longhorn-replicas": replicasAction,
};

export function actionRecipe<K extends DeployActionKind>(
  kind: K
): ActionRecipe<Extract<DeployActionRequest, { kind: K }>> | undefined {
  return recipes[kind];
}

const NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

export const actionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("longhorn-replicas"),
    replicas: z.number().int().min(1).max(3).optional(),
    existingVolumes: z.boolean(),
  }),
  z.object({
    kind: z.literal("migrate-to-longhorn"),
    namespace: z.string().regex(NAME, { message: "must be a namespace name" }),
    pvc: z
      .string()
      .max(253)
      .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, { message: "must be a PVC name" }),
    replicas: z.number().int().min(1).max(3).optional(),
    backupFirst: z.boolean().optional(),
  }),
]);

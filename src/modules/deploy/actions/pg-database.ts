import { randomBytes } from "node:crypto";
import type { PgDatabaseAction } from "../../../contracts/deploy.js";
import { pgName, pgSecretName } from "../../../contracts/postgres.js";
import { toYaml } from "../yaml.js";
import { display } from "../plan.js";
import type { ActionRecipe, ActionRendered } from "./index.js";
import { blockedAction } from "./migrate.js";
import {
  databaseFile,
  databaseObjects,
  databaseSteps,
  listOf,
  objectName,
  postgresBase,
  sharedCluster,
  type SharedPostgres,
} from "./pg-objects.js";

const KIND = "pg-database";
const MASKED = "********";
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

export const pgDatabaseAction: ActionRecipe<PgDatabaseAction> = {
  kind: KIND,

  async render(request, ctx): Promise<ActionRendered> {
    const title = `Give ${request.appId} a database on the shared Postgres`;
    const found = await sharedCluster(KIND, title, ctx);
    if ("refused" in found) return found.refused;
    const base = postgresBase(ctx);
    if (!DNS_LABEL.test(request.appId) || request.appId.length > 40) {
      return blockedAction(KIND, title, base, "appId must be a lowercase DNS label of at most 40 characters.");
    }
    if (!DNS_LABEL.test(request.namespace)) {
      return blockedAction(KIND, title, base, "namespace must be a lowercase DNS label.");
    }
    const pg: SharedPostgres = { namespace: found.cluster.metadata.namespace!, cluster: found.cluster.metadata.name };
    const password = ctx.run ? randomBytes(24).toString("base64url") : MASKED;
    const steps = databaseSteps(pg, request.appId);
    const object = objectName(pg.cluster, request.appId);
    const name = pgName(request.appId);
    return {
      ...base,
      plan: {
        kind: KIND,
        title,
        allowed: true,
        steps: [
          {
            label: `Make role and database ${name} on ${pg.cluster}`,
            commands: steps.map((s) => display(s.argv)),
          },
        ],
        rollback: "The role and database are kept if a step fails; running it again sets a new password.",
        changes: [],
        creates: [
          { kind: "DatabaseRole", name: object, namespace: pg.namespace },
          { kind: "Database", name: object, namespace: pg.namespace },
          { kind: "Secret", name: pgSecretName(request.appId), namespace: pg.namespace },
          { kind: "Secret", name: pgSecretName(request.appId), namespace: request.namespace },
        ],
        warnings: [
          `${request.appId} reads its connection from Secret ${request.namespace}/${pgSecretName(request.appId)}; a new password reaches it when it restarts.`,
        ],
      },
      steps,
      files: ctx.run
        ? {
            [databaseFile(request.appId)]: toYaml(
              listOf(databaseObjects(pg, request.appId, request.namespace, password))
            ),
          }
        : {},
      secrets: ctx.run ? [password] : [],
    };
  },
};

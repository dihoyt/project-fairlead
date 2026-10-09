import { createHash } from "node:crypto";
import type { DeployActionKind } from "../../../contracts/deploy.js";
import { deployedLabel } from "../../../contracts/deployed.js";
import { RESOURCES, type K8sApi, type KubeObject } from "../../../contracts/k8s.js";
import {
  POSTGRES_APP,
  POSTGRES_NAMESPACE,
  pgClusterLabel,
  pgClusterName,
  pgAppLabel,
  pgName,
  pgSecretAnnotation,
  pgSecretName,
} from "../../../contracts/postgres.js";
import { product } from "../../../product.js";
import { VALUES_DIR, type Step } from "../apps.js";
import type { YamlValue } from "../yaml.js";
import type { ActionContext, ActionRendered } from "./index.js";
import { blockedAction } from "./migrate.js";

// What the shared Postgres actions and the install recipes of apps that use
// it share: finding the cluster the apps use, and the objects that give an
// app its database. Everything the operator reconciles lives in the
// postgres namespace; only the app's connection Secret sits in the app's.

export const CNPG_API = "postgresql.cnpg.io/v1";
export const PG_PORT = 5432;
export const CLUSTER_LABEL = pgClusterLabel(product.ownerMarker.labelDomain);
const WAIT = "5m";

export interface SharedPostgres {
  namespace: string;
  // The Cluster the apps use now.
  cluster: string;
}

export interface CnpgCluster extends KubeObject {
  spec?: {
    instances?: number;
    imageName?: string;
    storage?: { size?: string; storageClass?: string };
    plugins?: Array<{ name?: string; isWALArchiver?: boolean; parameters?: Record<string, string> }>;
  };
  status?: {
    phase?: string;
    phaseReason?: string;
    instances?: number;
    readyInstances?: number;
    currentPrimary?: string;
    instancesStatus?: Record<string, string[]>;
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
  };
}

// The cluster labelled current, else the first one this product makes
// (installed before the label was read, or by an older build); undefined
// when there is none, "absent" when CloudNativePG isn't installed.
export async function currentCluster(k8s: K8sApi): Promise<CnpgCluster | undefined | "absent"> {
  const clusters = await k8s.list<CnpgCluster>(RESOURCES.cnpgClusters, { namespace: POSTGRES_NAMESPACE });
  if (clusters === "absent") return "absent";
  return (
    clusters.find((c) => c.metadata.labels?.[CLUSTER_LABEL] === "current") ??
    clusters.find((c) => c.metadata.name === pgClusterName(product.slug))
  );
}

export const rwHost = (pg: SharedPostgres) => `${pg.cluster}-rw.${pg.namespace}.svc`;

// Each object is named after the cluster as well as the app: its cluster
// reference can't change, so a cluster a restore makes gets objects of its own.
export const objectName = (cluster: string, appId: string) => `${cluster}-${appId}`.slice(0, 63).replace(/-+$/, "");

// A pod annotation that changes only when the password does, so a new
// password restarts the app while a re-run with the same one doesn't.
export const passwordStamp = (password: string) => createHash("sha256").update(password).digest("hex").slice(0, 16);
export const PASSWORD_ANNOTATION = `${product.ownerMarker.labelDomain}/postgres-password`;

// The role, its password Secret, the database and the app's connection
// Secret (in a Namespace object, since the app's chart may not have made it
// yet), in apply order.
export function databaseObjects(
  pg: SharedPostgres,
  appId: string,
  appNamespace: string,
  password: string
): KubeObject[] {
  const name = pgName(appId);
  const host = rwHost(pg);
  const labels = { "app.kubernetes.io/managed-by": product.ownerMarker.labelDomain, ...deployedLabel() };
  const object = objectName(pg.cluster, appId);
  const owned = {
    labels: { ...labels, [pgAppLabel(product.ownerMarker.labelDomain)]: appId },
    annotations: {
      [pgSecretAnnotation(product.ownerMarker.labelDomain)]: `${appNamespace}/${pgSecretName(appId)}`,
    },
  };
  return [
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: pgSecretName(appId),
        namespace: pg.namespace,
        // The operator watches Secrets it should reload only with this label.
        labels: { ...labels, "cnpg.io/reload": "true" },
      },
      type: "kubernetes.io/basic-auth",
      stringData: { username: name, password },
    } as KubeObject,
    {
      apiVersion: CNPG_API,
      kind: "DatabaseRole",
      metadata: { name: object, namespace: pg.namespace, ...owned },
      spec: {
        cluster: { name: pg.cluster },
        name,
        login: true,
        passwordSecret: { name: pgSecretName(appId) },
        databaseRoleReclaimPolicy: "retain",
      },
    } as KubeObject,
    {
      apiVersion: CNPG_API,
      kind: "Database",
      metadata: { name: object, namespace: pg.namespace, ...owned },
      spec: { cluster: { name: pg.cluster }, name, owner: name, databaseReclaimPolicy: "retain" },
    } as KubeObject,
    { apiVersion: "v1", kind: "Namespace", metadata: { name: appNamespace } },
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: pgSecretName(appId), namespace: appNamespace, labels },
      type: "Opaque",
      stringData: {
        host,
        port: String(PG_PORT),
        dbname: name,
        user: name,
        password,
        uri: `postgresql://${name}:${encodeURIComponent(password)}@${host}:${PG_PORT}/${name}`,
      },
    } as KubeObject,
  ];
}

export const databaseFile = (appId: string) => `postgres-${appId}.yaml`;

// Apply, then wait for the operator to have made the role and the database,
// so the app finds them when it starts.
export function databaseSteps(pg: SharedPostgres, appId: string): Step[] {
  const object = objectName(pg.cluster, appId);
  const wait = (resource: string): Step => ({
    argv: [
      "kubectl",
      "wait",
      `${resource}.postgresql.cnpg.io/${object}`,
      "--namespace",
      pg.namespace,
      "--for=jsonpath={.status.applied}=true",
      `--timeout=${WAIT}`,
    ],
  });
  return [
    {
      argv: ["kubectl", "apply", "-f", `${VALUES_DIR}/${databaseFile(appId)}`],
      dryRun: "--dry-run=client",
    },
    wait("databaseroles"),
    wait("databases"),
  ];
}

export const listOf = (items: KubeObject[]): YamlValue =>
  ({ apiVersion: "v1", kind: "List", items }) as unknown as YamlValue;

// The deploy job row every shared Postgres action takes.
export const postgresBase = (ctx: ActionContext) => ({
  appId: POSTGRES_APP,
  release: POSTGRES_APP,
  namespace: POSTGRES_NAMESPACE,
  version: ctx.versions.get(POSTGRES_APP) ?? "",
});

export const NO_CLUSTER = "There is no shared Postgres; install it from the catalog first.";
export const NO_OPERATOR = "CloudNativePG is not installed: its objects are not served by this cluster.";

// Refusals every shared Postgres action shares; otherwise the cluster.
export async function sharedCluster(
  kind: DeployActionKind,
  title: string,
  ctx: ActionContext
): Promise<{ cluster: CnpgCluster } | { refused: ActionRendered }> {
  const base = postgresBase(ctx);
  if (!ctx.k8s) return { refused: blockedAction(kind, title, base, "The Kubernetes API is not available.") };
  if (!ctx.enabled) {
    return {
      refused: blockedAction(
        kind,
        title,
        base,
        `Deploys are off.${ctx.enableHint ? ` Turn them on with: ${ctx.enableHint}` : ""}`
      ),
    };
  }
  const cluster = await currentCluster(ctx.k8s);
  if (cluster === "absent") return { refused: blockedAction(kind, title, base, NO_OPERATOR) };
  if (!cluster) return { refused: blockedAction(kind, title, base, NO_CLUSTER) };
  return { cluster };
}

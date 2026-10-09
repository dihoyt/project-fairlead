import { readFileSync } from "node:fs";
import { z } from "zod";
import type { SettingsRegistry } from "../../contracts/platform.js";
import { product } from "../../product.js";
import type { Defaults } from "./apps.js";
import { parseCron } from "./cron.js";

const SA_NAMESPACE = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";

function podNamespace(): string {
  try {
    return readFileSync(SA_NAMESPACE, "utf8").trim() || product.defaultNamespace;
  } catch {
    return product.defaultNamespace;
  }
}

const optionalName = z.string().trim().max(253);

export interface DeployConfig {
  // Settings an admin may override; empty means "use what discovery found".
  defaults(): Defaults;
  // Set by the chart; read-only in the admin UI.
  image(): string;
  serviceAccount(): string;
  namespace(): string;
  release(): string;
  chart(): string;
  // The console's nightly database copy: a five-field cron in UTC, "" off.
  consoleBackup(): string;
  consoleBackupKeep(): number;
}

export function declareConfig(settings: SettingsRegistry): DeployConfig {
  const baseDomain = settings.declare({
    key: "deploy.baseDomain",
    label: "Base domain for new apps",
    help: "New apps are offered <app>.<base domain> as their hostname. Empty: the domain most Ingresses share.",
    schema: optionalName,
    default: "",
    env: "DEPLOY_BASE_DOMAIN",
  });
  const ingressClass = settings.declare({
    key: "deploy.ingressClass",
    label: "Ingress class for new apps",
    help: "Empty: the cluster's default ingress class.",
    schema: optionalName,
    default: "",
    env: "DEPLOY_INGRESS_CLASS",
  });
  const clusterIssuer = settings.declare({
    key: "deploy.clusterIssuer",
    label: "cert-manager ClusterIssuer for new apps",
    help: "Empty: the issuer discovery found. With none, apps are served over plain HTTP.",
    schema: optionalName,
    default: "",
    env: "DEPLOY_CLUSTER_ISSUER",
  });
  const storageClass = settings.declare({
    key: "deploy.storageClass",
    label: "Storage class for new apps",
    help: "Empty: the cluster's default storage class.",
    schema: optionalName,
    default: "",
    env: "DEPLOY_STORAGE_CLASS",
  });
  const image = settings.declare({
    key: "deploy.image",
    label: "Installer image",
    help: "The helm and kubectl image deploy Jobs run, pinned by digest in the chart.",
    schema: z.string(),
    default: "",
    env: "DEPLOY_IMAGE",
    envOnly: true,
  });
  const serviceAccount = settings.declare({
    key: "deploy.serviceAccount",
    label: "Installer service account",
    schema: z.string(),
    default: `${product.chartName}-installer`,
    env: "DEPLOY_SERVICE_ACCOUNT",
    envOnly: true,
  });
  const namespace = settings.declare({
    key: "deploy.namespace",
    label: "Namespace deploy Jobs run in",
    schema: z.string(),
    default: podNamespace(),
    env: "POD_NAMESPACE",
    envOnly: true,
  });
  const release = settings.declare({
    key: "deploy.release",
    label: "This install's Helm release",
    schema: z.string(),
    default: product.chartName,
    env: "HELM_RELEASE",
    envOnly: true,
  });

  const chart = settings.declare({
    key: "deploy.chart",
    label: "This install's chart",
    schema: z.string(),
    default: `oci://${product.imageRegistry}/charts/${product.chartName}`,
    env: "DEPLOY_CHART",
    envOnly: true,
  });

  const consoleBackup = settings.declare({
    key: "deploy.consoleBackup",
    label: "Console backup schedule",
    help: "When the console copies its own database to the storage target: five-field cron in UTC. Empty: never.",
    schema: z
      .string()
      .trim()
      .refine((v) => v === "" || parseCron(v) !== null, "Use a five-field cron such as 30 3 * * *, or leave it empty."),
    default: "30 3 * * *",
  });
  const consoleBackupKeep = settings.declare({
    key: "deploy.consoleBackupKeep",
    label: "Console backups kept",
    help: "How many copies of the console's database stay on the storage target.",
    schema: z.number().int().min(1).max(90),
    default: 14,
  });

  return {
    defaults: () => ({
      baseDomain: baseDomain.get() || undefined,
      ingressClass: ingressClass.get() || undefined,
      clusterIssuer: clusterIssuer.get() || undefined,
      storageClass: storageClass.get() || undefined,
    }),
    image: () => image.get(),
    serviceAccount: () => serviceAccount.get(),
    namespace: () => namespace.get(),
    release: () => release.get(),
    chart: () => chart.get(),
    consoleBackup: () => consoleBackup.get(),
    consoleBackupKeep: () => consoleBackupKeep.get(),
  };
}

// The one line that turns deploys on for this release.
export function enableHint(config: DeployConfig): string {
  return `helm upgrade ${config.release()} ${config.chart()} -n ${config.namespace()} --reuse-values --set deploy.enabled=true`;
}

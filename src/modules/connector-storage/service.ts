import {
  STORAGE_TARGET_KIND,
  type ConnectorInstance,
  type ConnectorRegistry,
  type StorageCredentialsSecret,
  type StorageTargetService,
  type StorageTargetUse,
  type StorageTargetView,
} from "../../contracts/connectors.js";
import type { CheckResult } from "../../contracts/health.js";
import { RESOURCES, type K8sApi, type KubeObject } from "../../contracts/k8s.js";
import { product } from "../../product.js";
import { locate } from "./kind.js";
import { isProtocol, sameTarget, serverOf, targetUrl } from "./url.js";

export const LONGHORN_NAMESPACE = "longhorn-system";

interface LonghornBackupTarget extends KubeObject {
  spec?: { backupTargetURL?: string; credentialSecret?: string };
  status?: {
    available?: boolean;
    lastSyncedAt?: string;
    conditions?: Array<{ type?: string; status?: string; message?: string; reason?: string }>;
  };
}

export interface ServiceDeps {
  registry: () => ConnectorRegistry;
  // Undefined when the k8s service isn't there (tests without a cluster).
  k8s: () => K8sApi | undefined;
  now?: () => Date;
}

// The URL Longhorn would get for an instance, or "" when its settings don't
// parse (the view then shows the verify error in its checks).
export function urlOf(instance: Pick<ConnectorInstance, "config">): string {
  const located = locate(instance.config);
  return "error" in located ? "" : targetUrl(located.target, instance.config.path ?? "");
}

const k8sName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

export const secretNameFor = (id: string) => k8sName(`${product.ownerMarker.externalPrefix}backup-${id}`);

// Longhorn's message when the target isn't available: the Unavailable
// condition's, verbatim.
function longhornMessage(bt: LonghornBackupTarget): string | undefined {
  const cond = bt.status?.conditions?.find((c) => c.type === "Unavailable" && c.status === "True");
  return cond?.message || cond?.reason || undefined;
}

// What on the cluster points at a target URL.
export function usesOf(url: string, targets: LonghornBackupTarget[]): StorageTargetUse[] {
  if (!url) return [];
  return targets
    .filter((bt) => bt.spec?.backupTargetURL && sameTarget(bt.spec.backupTargetURL, url))
    .map((bt) => {
      const message = bt.status?.available === false ? longhornMessage(bt) : undefined;
      return {
        kind: "longhorn",
        label: bt.metadata.name === "default" ? "Longhorn backup target" : `Longhorn backup target ${bt.metadata.name}`,
        ...(typeof bt.status?.available === "boolean" ? { available: bt.status.available } : {}),
        ...(message ? { message } : {}),
        ...(bt.status?.lastSyncedAt ? { lastSyncAt: bt.status.lastSyncedAt } : {}),
      } satisfies StorageTargetUse;
    });
}

export function createStorageService(deps: ServiceDeps): StorageTargetService & {
  // BackupTargets Longhorn has, empty when Longhorn isn't installed.
  backupTargets(): Promise<LonghornBackupTarget[]>;
  longhornCheck(instance: ConnectorInstance): Promise<CheckResult | undefined>;
} {
  const now = deps.now ?? (() => new Date());

  async function backupTargets(): Promise<LonghornBackupTarget[]> {
    const k8s = deps.k8s();
    if (!k8s) return [];
    try {
      const listed = await k8s.list<LonghornBackupTarget>(RESOURCES.longhornBackupTargets, {
        namespace: LONGHORN_NAMESPACE,
      });
      return listed === "absent" ? [] : listed;
    } catch {
      return [];
    }
  }

  async function toView(instance: ConnectorInstance, targets: LonghornBackupTarget[]): Promise<StorageTargetView> {
    const view = await deps.registry().view(instance.id);
    const url = urlOf(instance);
    const located = locate(instance.config);
    const given = instance.config.protocol ?? "";
    const protocol = isProtocol(given) ? given : "nfs";
    const server = "error" in located ? "" : located.target.protocol === "s3" ? located.host : serverOf(located.target);
    const endpoint = protocol === "s3" ? instance.config.endpoint?.trim() : undefined;
    const credential = protocol === "s3" ? "secretAccessKey" : protocol === "smb" ? "password" : undefined;
    return {
      id: instance.id,
      name: instance.name,
      protocol,
      url,
      ...(endpoint ? { endpoint } : {}),
      ...(server ? { server } : {}),
      hasCredentials: credential ? Boolean(instance.secrets[credential]) : false,
      status: view?.status ?? "unknown",
      checks: view?.checks ?? [],
      ...(view?.checkedAt ? { checkedAt: view.checkedAt } : {}),
      usedBy: usesOf(url, targets),
    };
  }

  const instances = () => deps.registry().instances(STORAGE_TARGET_KIND);

  return {
    backupTargets,
    async list() {
      const [all, targets] = await Promise.all([instances(), backupTargets()]);
      const views = await Promise.all(all.map((i) => toView(i, targets)));
      return views.toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    },
    async get(id) {
      const instance = await deps.registry().instance(id);
      if (!instance || instance.kind !== STORAGE_TARGET_KIND) return undefined;
      return toView(instance, await backupTargets());
    },
    async credentialsSecret(id, namespace) {
      const instance = await deps.registry().instance(id);
      if (!instance || instance.kind !== STORAGE_TARGET_KIND) throw new Error(`No storage target "${id}".`);
      const protocol = instance.config.protocol;
      if (protocol === "nfs") return undefined;
      const need = (key: string, from: Record<string, string>) => {
        const value = from[key]?.trim();
        if (!value) throw new Error(`Storage target "${instance.name}" has no stored ${key}; edit it and save one.`);
        return value;
      };
      let stringData: Record<string, string>;
      if (protocol === "s3") {
        const endpoint = instance.config.endpoint?.trim();
        stringData = {
          AWS_ACCESS_KEY_ID: need("accessKeyId", instance.config),
          AWS_SECRET_ACCESS_KEY: need("secretAccessKey", instance.secrets),
          ...(endpoint ? { AWS_ENDPOINTS: endpoint } : {}),
        };
      } else if (protocol === "smb") {
        stringData = {
          CIFS_USERNAME: need("username", instance.config),
          CIFS_PASSWORD: need("password", instance.secrets),
        };
      } else {
        throw new Error(`Storage target "${instance.name}" has no protocol set.`);
      }
      const secret: StorageCredentialsSecret = {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: secretNameFor(id),
          namespace,
          labels: { "app.kubernetes.io/managed-by": product.ownerMarker.labelDomain },
        },
        type: "Opaque",
        stringData,
      };
      return secret;
    },
    async longhornCheck(instance) {
      const uses = usesOf(urlOf(instance), await backupTargets());
      const use = uses[0];
      if (!use || use.available === undefined) return undefined;
      return {
        id: "longhorn",
        label: "Longhorn",
        status: use.available ? "ok" : "crit",
        detail: use.available
          ? "Longhorn mounts it as its backup target"
          : `Longhorn can't use it as its backup target${use.message ? `: ${use.message}` : ""}`,
        observedAt: now().toISOString(),
        ...(use.available ? {} : { raw: { available: false, message: use.message } }),
      };
    },
  };
}

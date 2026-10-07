import type { PvcRef } from "../../contracts/backups.js";
import { RESOURCES, type K8sApi, type KubeObject } from "../../contracts/k8s.js";

export interface ClusterPvc {
  ref: PvcRef;
  sizeBytes?: number;
  storageClass?: string;
  app?: string;
  // Mounted by this console's own pod: its database volume.
  ownData?: boolean;
  // On NFS, whose server may well back it up where the cluster cannot see.
  nfs?: boolean;
}

// This console's pod, to recognise the volume it keeps its own data on.
export interface SelfPod {
  name: string;
  // Unknown outside a cluster; the name alone is then matched.
  namespace?: string;
}

interface PvcObject extends KubeObject {
  spec?: { storageClassName?: string; volumeName?: string; resources?: { requests?: { storage?: string } } };
  status?: { capacity?: { storage?: string } };
}

interface PodObject extends KubeObject {
  spec?: { volumes?: Array<{ persistentVolumeClaim?: { claimName?: string } }> };
}

interface StorageClassObject extends KubeObject {
  provisioner?: string;
}

interface PvObject extends KubeObject {
  spec?: { nfs?: unknown; storageClassName?: string; csi?: { driver?: string } };
}

// nfs.csi.k8s.io, nfs-subdir-external-provisioner, nfs-ganesha and the like
// all say so in the provisioner; a class named for NFS is taken at its word.
export const isNfsClass = (sc: StorageClassObject) =>
  /nfs/i.test(sc.provisioner ?? "") || /nfs/i.test(sc.metadata.name);

interface StatefulSetObject extends KubeObject {
  spec?: { volumeClaimTemplates?: Array<{ metadata?: { name?: string } }> };
}

const BINARY: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DECIMAL: Record<string, number> = { m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

// A Kubernetes resource.Quantity as bytes: "10Gi", "500M", "1.5e9".
export function parseQuantity(quantity: string | undefined): number | undefined {
  if (!quantity) return undefined;
  const match = /^([0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)(Ki|Mi|Gi|Ti|Pi|Ei|m|k|M|G|T|P|E)?$/.exec(quantity.trim());
  if (!match) return undefined;
  const suffix = match[2];
  const scale = suffix ? (BINARY[suffix] ?? DECIMAL[suffix] ?? 1) : 1;
  return Math.round(Number(match[1]) * scale);
}

const byName = (list: KubeObject[]) => new Map(list.map((o) => [`${o.metadata.namespace}/${o.metadata.name}`, o]));

const items = <T>(result: T[] | "absent"): T[] => (result === "absent" ? [] : result);

function controllerOf(obj: KubeObject) {
  const owners = obj.metadata.ownerReferences ?? [];
  return owners.find((o) => o.controller) ?? owners[0];
}

// PVCs with the workloads that mount them. A pod's owner is followed one
// level further for ReplicaSet → Deployment and Job → CronJob, so the app
// reads the way people name it. A StatefulSet scaled to zero still owns its
// claims through volumeClaimTemplates ("<template>-<sts>-<ordinal>").
// A PV that names an NFS server directly counts too, whatever its class.
export async function listPvcs(k8s: K8sApi, self?: SelfPod): Promise<ClusterPvc[]> {
  const [pvcs, pods, replicaSets, jobs, statefulSets, storageClasses, pvs] = await Promise.all([
    k8s.list<PvcObject>(RESOURCES.pvcs),
    k8s.list<PodObject>(RESOURCES.pods),
    k8s.list(RESOURCES.replicaSets),
    k8s.list(RESOURCES.jobs),
    k8s.list<StatefulSetObject>(RESOURCES.statefulSets),
    // Optional: without them a PVC is simply not recognised as NFS.
    k8s.list<StorageClassObject>(RESOURCES.storageClasses).catch(() => "absent" as const),
    k8s.list<PvObject>(RESOURCES.pvs).catch(() => "absent" as const),
  ]);
  const nfsClasses = new Set(
    items(storageClasses)
      .filter(isNfsClass)
      .map((sc) => sc.metadata.name)
  );
  const pvByName = new Map(items(pvs).map((pv) => [pv.metadata.name, pv]));
  const isNfsPv = (pv: PvObject | undefined) =>
    !!pv && (pv.spec?.nfs !== undefined || /nfs/i.test(pv.spec?.csi?.driver ?? ""));
  const own = new Set<string>();

  const parents: Record<string, Map<string, KubeObject>> = {
    ReplicaSet: byName(items(replicaSets)),
    Job: byName(items(jobs)),
  };

  const appOf = (pod: KubeObject): string => {
    const owner = controllerOf(pod);
    if (!owner) return `Pod/${pod.metadata.name}`;
    const parent = parents[owner.kind]?.get(`${pod.metadata.namespace}/${owner.name}`);
    const grand = parent ? controllerOf(parent) : undefined;
    if (grand) return `${grand.kind}/${grand.name}`;
    // A Deployment names its ReplicaSets "<deployment>-<pod-template-hash>",
    // which still identifies it when the ReplicaSet itself was not listed.
    const hash = pod.metadata.labels?.["pod-template-hash"];
    if (!parent && owner.kind === "ReplicaSet" && hash && owner.name.endsWith(`-${hash}`)) {
      return `Deployment/${owner.name.slice(0, -hash.length - 1)}`;
    }
    return `${owner.kind}/${owner.name}`;
  };

  const apps = new Map<string, Set<string>>();
  const addApp = (key: string, app: string) => {
    if (!apps.has(key)) apps.set(key, new Set());
    apps.get(key)!.add(app);
  };
  const isSelf = (pod: KubeObject) =>
    !!self && pod.metadata.name === self.name && (!self.namespace || pod.metadata.namespace === self.namespace);
  for (const pod of items(pods)) {
    for (const volume of pod.spec?.volumes ?? []) {
      const claim = volume.persistentVolumeClaim?.claimName;
      if (!claim) continue;
      addApp(`${pod.metadata.namespace}/${claim}`, appOf(pod));
      if (isSelf(pod)) own.add(`${pod.metadata.namespace}/${claim}`);
    }
  }

  const templates: Array<{ namespace: string; prefix: string; app: string }> = [];
  for (const sts of items(statefulSets)) {
    for (const template of sts.spec?.volumeClaimTemplates ?? []) {
      if (!template.metadata?.name) continue;
      templates.push({
        namespace: sts.metadata.namespace ?? "",
        prefix: `${template.metadata.name}-${sts.metadata.name}-`,
        app: `StatefulSet/${sts.metadata.name}`,
      });
    }
  }

  return items(pvcs).map((pvc): ClusterPvc => {
    const namespace = pvc.metadata.namespace ?? "";
    const name = pvc.metadata.name;
    const key = `${namespace}/${name}`;
    if (!apps.has(key)) {
      const owner = templates.find(
        (t) => t.namespace === namespace && name.startsWith(t.prefix) && /^[0-9]+$/.test(name.slice(t.prefix.length))
      );
      if (owner) addApp(key, owner.app);
    }
    const size = parseQuantity(pvc.status?.capacity?.storage ?? pvc.spec?.resources?.requests?.storage);
    const app = apps.get(key);
    const storageClass = pvc.spec?.storageClassName;
    const nfs =
      (!!storageClass && nfsClasses.has(storageClass)) ||
      isNfsPv(pvc.spec?.volumeName ? pvByName.get(pvc.spec.volumeName) : undefined);
    return {
      ref: { namespace, name, uid: pvc.metadata.uid ?? "" },
      ...(size !== undefined ? { sizeBytes: size } : {}),
      ...(pvc.spec?.storageClassName ? { storageClass: pvc.spec.storageClassName } : {}),
      ...(app ? { app: [...app].toSorted().join(", ") } : {}),
      ...(own.has(key) ? { ownData: true } : {}),
      ...(nfs ? { nfs: true } : {}),
    };
  });
}

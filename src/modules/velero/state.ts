import type { K8sApi, KubeObject } from "../../contracts/k8s.js";
import { RESOURCES } from "../../contracts/k8s.js";
import type { VeleroBackup, VeleroLocation, VeleroRestore, VeleroSchedule } from "./objects.js";

export interface VeleroState {
  backups: VeleroBackup[];
  schedules: VeleroSchedule[];
  restores: VeleroRestore[];
  locations: VeleroLocation[];
}

const orEmpty = <T>(list: T[] | "absent") => (list === "absent" ? [] : list);

// Every Velero object the module judges, read in one pass. "absent" when
// the velero.io group is not served: Velero is not installed.
export async function readVelero(k8s: K8sApi): Promise<VeleroState | "absent"> {
  const [backups, schedules, restores, locations] = await Promise.all([
    k8s.list<VeleroBackup>(RESOURCES.veleroBackups),
    k8s.list<VeleroSchedule>(RESOURCES.veleroSchedules),
    k8s.list<VeleroRestore>(RESOURCES.veleroRestores),
    k8s.list<VeleroLocation>(RESOURCES.veleroBackupStorageLocations),
  ]);
  if (backups === "absent" && schedules === "absent" && locations === "absent") return "absent";
  return {
    backups: orEmpty(backups),
    schedules: orEmpty(schedules),
    restores: orEmpty(restores),
    locations: orEmpty(locations),
  };
}

export interface PvcObject extends KubeObject {
  spec?: { volumeName?: string; storageClassName?: string };
  status?: { phase?: string };
}

export interface PodObject extends KubeObject {
  spec?: { volumes?: Array<{ name: string; persistentVolumeClaim?: { claimName?: string } }> };
  status?: { phase?: string };
}

export async function readClaims(k8s: K8sApi): Promise<{ pvcs: PvcObject[]; pods: PodObject[] }> {
  const [pvcs, pods] = await Promise.all([k8s.list<PvcObject>(RESOURCES.pvcs), k8s.list<PodObject>(RESOURCES.pods)]);
  return { pvcs: orEmpty(pvcs), pods: orEmpty(pods) };
}

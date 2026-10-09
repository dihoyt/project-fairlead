import type { DeployActionStep, LonghornRestoreAction, PlannedObject } from "../../../contracts/deploy.js";
import { formatBytes } from "../../../contracts/disk.js";
import { RESOURCES, type K8sApi, type KubeObject } from "../../../contracts/k8s.js";
import { product } from "../../../product.js";
import { display } from "../plan.js";
import type { ActionRecipe, ActionRendered } from "./index.js";
import { blockedAction, describeDowntime, LONGHORN_PROVISIONER, newRunId, parseQuantity } from "./migrate.js";
import {
  LONGHORN_API,
  LONGHORN_NAMESPACE,
  NOT_INSTALLED,
  longhornBase,
  refuse,
  volumeOfClaim,
  type LonghornBackup,
} from "./longhorn-objects.js";

// A Longhorn backup restored into a new Longhorn volume, then either bound
// to a new claim beside the old one (the app untouched) or swapped in under
// the claim's own name while the app is stopped. The swap keeps the old
// volume (Retain) until the app is back up, as actions/migrate.ts does.

const KIND = "longhorn-restore";
const RESTORE_TIMEOUT_SECONDS = 4 * 3600;
const FIXED_DOWNTIME_SECONDS = 120;
const RESTORE_BYTES_PER_SECOND = 40 * 1024 ** 2;
export const CLAIM_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

interface PvcLike extends KubeObject {
  spec?: {
    storageClassName?: string;
    volumeName?: string;
    accessModes?: string[];
    volumeMode?: string;
    resources?: { requests?: { storage?: string } };
  };
  status?: { phase?: string };
}

interface PodSpecLike {
  nodeName?: string;
  volumes?: Array<{ persistentVolumeClaim?: { claimName?: string } }>;
}

export interface RestoreWorkload {
  kind: "deployment" | "statefulset";
  name: string;
  replicas: number;
}

const mounts = (spec: PodSpecLike | undefined, claim: string) =>
  (spec?.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === claim);

// The Deployments and StatefulSets whose pods mount the claim, or why the
// claim can't be freed from here.
export async function claimWorkloads(
  k8s: K8sApi,
  namespace: string,
  claim: string
): Promise<{ workloads: RestoreWorkload[]; blockedBy?: string }> {
  const list = async (ref: (typeof RESOURCES)[keyof typeof RESOURCES]) => {
    const found = await k8s.list(ref, { namespace });
    return found === "absent" ? [] : found;
  };
  const [deployments, statefulSets, pods] = await Promise.all([
    list(RESOURCES.deployments),
    list(RESOURCES.statefulSets),
    list(RESOURCES.pods),
  ]);
  const workloads: RestoreWorkload[] = [];
  for (const d of deployments) {
    const spec = d.spec as { replicas?: number; template?: { spec?: PodSpecLike } } | undefined;
    if (mounts(spec?.template?.spec, claim)) {
      workloads.push({ kind: "deployment", name: d.metadata.name, replicas: spec?.replicas ?? 1 });
    }
  }
  for (const s of statefulSets) {
    const spec = s.spec as
      | {
          replicas?: number;
          template?: { spec?: PodSpecLike };
          volumeClaimTemplates?: Array<{ metadata?: { name?: string } }>;
        }
      | undefined;
    const replicas = spec?.replicas ?? 1;
    const templated = (spec?.volumeClaimTemplates ?? []).some((t) =>
      Array.from({ length: replicas }, (_, i) => `${t.metadata?.name}-${s.metadata.name}-${i}`).includes(claim)
    );
    if (templated || mounts(spec?.template?.spec, claim)) {
      workloads.push({ kind: "statefulset", name: s.metadata.name, replicas });
    }
  }
  const names = new Set(workloads.map((w) => w.name));
  for (const pod of pods) {
    if (!mounts(pod.spec as PodSpecLike, claim)) continue;
    const owner = pod.metadata.ownerReferences?.[0];
    const ownerName = owner?.kind === "ReplicaSet" ? owner.name.replace(/-[a-z0-9]+$/, "") : owner?.name;
    if (!ownerName || !names.has(ownerName)) {
      return { workloads, blockedBy: `Pod ${pod.metadata.name} also mounts ${claim} and can't be stopped from here.` };
    }
  }
  return { workloads };
}

const restoredVolumeName = (runId: string) => `${product.ownerMarker.externalPrefix}restore-${runId}`.slice(0, 40);

export interface RestoreFilesInput {
  mode: "new-pvc" | "in-place";
  namespace: string;
  claim: PvcLike;
  // The claim the restored volume is bound to: newClaim, or the claim itself.
  boundClaim: string;
  volume: string;
  backupUrl: string;
  backupName: string;
  sizeBytes: string;
  replicas: number;
  accessMode?: string;
  dataEngine?: string;
  oldPv?: string;
  oldReclaim?: string;
  workloads: RestoreWorkload[];
  labels: Record<string, string>;
}

// Annotations the control plane writes on a bound claim; a fresh claim must
// not carry them.
const BINDING_ANNOTATIONS = /^(pv\.kubernetes\.io\/|volume\.beta\.kubernetes\.io\/|volume\.kubernetes\.io\/)/;

function claimFrom(old: PvcLike, name: string, volumeName: string, extraLabels?: Record<string, string>): KubeObject {
  const annotations = Object.fromEntries(
    Object.entries(old.metadata.annotations ?? {}).filter(([key]) => !BINDING_ANNOTATIONS.test(key))
  );
  const labels = { ...(name === old.metadata.name ? old.metadata.labels : {}), ...extraLabels };
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name,
      namespace: old.metadata.namespace,
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
      ...(name === old.metadata.name && Object.keys(annotations).length > 0 ? { annotations } : {}),
    },
    spec: {
      accessModes: old.spec?.accessModes ?? ["ReadWriteOnce"],
      resources: { requests: { storage: old.spec?.resources?.requests?.storage } },
      storageClassName: old.spec?.storageClassName ?? "",
      volumeName,
    },
  };
}

export function restoreFiles(i: RestoreFilesInput): Record<string, string> {
  const volume: KubeObject = {
    apiVersion: LONGHORN_API,
    kind: "Volume",
    metadata: { name: i.volume, namespace: LONGHORN_NAMESPACE, labels: i.labels },
    spec: {
      fromBackup: i.backupUrl,
      size: i.sizeBytes,
      numberOfReplicas: i.replicas,
      frontend: "blockdev",
      ...(i.accessMode ? { accessMode: i.accessMode } : {}),
      ...(i.dataEngine ? { dataEngine: i.dataEngine } : {}),
    },
  };
  const pv: KubeObject = {
    apiVersion: "v1",
    kind: "PersistentVolume",
    metadata: {
      name: i.volume,
      labels: i.labels,
      // So the claim's later deletion removes the Longhorn volume too, as
      // for a volume the CSI driver made itself.
      annotations: { "pv.kubernetes.io/provisioned-by": LONGHORN_PROVISIONER },
    },
    spec: {
      capacity: { storage: i.claim.spec?.resources?.requests?.storage },
      accessModes: i.claim.spec?.accessModes ?? ["ReadWriteOnce"],
      // Retain until the claim is bound and, in place, the app is back up.
      persistentVolumeReclaimPolicy: "Retain",
      storageClassName: i.claim.spec?.storageClassName ?? "",
      ...(i.claim.spec?.volumeMode ? { volumeMode: i.claim.spec.volumeMode } : {}),
      csi: { driver: LONGHORN_PROVISIONER, fsType: "ext4", volumeHandle: i.volume },
    },
  };
  const files: Record<string, string> = {
    "volume.json": JSON.stringify(volume),
    "pv.json": JSON.stringify(pv),
    "claim.json": JSON.stringify(
      claimFrom(i.claim, i.boundClaim, i.volume, i.mode === "new-pvc" ? i.labels : undefined)
    ),
    "plan.json": JSON.stringify({
      mode: i.mode,
      namespace: i.namespace,
      claim: i.boundClaim,
      volume: i.volume,
      backup: i.backupName,
      restoreTimeoutSeconds: RESTORE_TIMEOUT_SECONDS,
      workloads: i.workloads,
      ...(i.oldPv ? { oldPv: i.oldPv, oldReclaim: i.oldReclaim ?? "Delete" } : {}),
    }),
  };
  if (i.mode === "in-place" && i.oldPv)
    files["old.json"] = JSON.stringify(claimFrom(i.claim, i.claim.metadata.name, i.oldPv));
  return files;
}

// Fixed; every name comes from /values/plan.json and the object files beside
// it. In place, until the old volume is deleted, any failure stops the app,
// puts the claim back on its old volume and starts the app again.
export const RESTORE_SCRIPT = `set -eu
P=/values/plan.json
NS=$(jq -r .namespace "$P")
MODE=$(jq -r .mode "$P")
CLAIM=$(jq -r .claim "$P")
VOL=$(jq -r .volume "$P")
STEP="starting"
COMMITTED=0
SWAPPED=0

k() { kubectl -n "$NS" "$@"; }
lh() { kubectl -n ${LONGHORN_NAMESPACE} "$@"; }
pv_policy() { kubectl patch pv "$1" -p "{\\"spec\\":{\\"persistentVolumeReclaimPolicy\\":\\"$2\\"}}" >/dev/null; }

scale_all() {
  jq -r '.workloads[] | "\\(.kind) \\(.name) \\(.replicas)"' "$P" | while read -r kind name replicas; do
    if [ "$1" = zero ]; then n=0; else n=$replicas; fi
    k scale "$kind/$name" --replicas="$n"
  done
}

wait_unmounted() {
  tries=0
  while :; do
    n=$(k get pods -o json | jq --arg c "$CLAIM" \\
      '[.items[] | select(any(.spec.volumes[]?; (.persistentVolumeClaim.claimName // "") == $c))] | length')
    [ "$n" -eq 0 ] && return 0
    tries=$((tries + 1))
    [ "$tries" -lt 120 ] || { echo "error: pods still use $CLAIM after 10 minutes"; return 1; }
    sleep 5
  done
}

wait_bound() {
  tries=0
  until [ "$(k get pvc "$1" -o jsonpath='{.status.phase}')" = Bound ]; do
    tries=$((tries + 1))
    [ "$tries" -lt 60 ] || { echo "error: claim $1 was not bound after 5 minutes"; return 1; }
    sleep 5
  done
}

# Longhorn attaches the new volume, pulls the backup into it and detaches it.
wait_restored() {
  end=$(($(date +%s) + $(jq -r .restoreTimeoutSeconds "$P")))
  while :; do
    s=$(lh get volumes.longhorn.io "$VOL" -o json | jq -r \\
      '"\\(.status.restoreInitiated == true) \\(.status.restoreRequired == false) \\(.status.state // "")"')
    case "$s" in
      "true true detached") return 0 ;;
      *faulted*) echo "error: Longhorn reports volume $VOL as faulted"; return 1 ;;
    esac
    [ "$(date +%s)" -lt "$end" ] || { echo "error: the restore did not finish in time ($s)"; return 1; }
    sleep 10
  done
}

discard_new() {
  kubectl delete pv "$VOL" --ignore-not-found --wait=false >/dev/null || true
  lh delete volumes.longhorn.io "$VOL" --ignore-not-found --wait=false >/dev/null || true
}

on_exit() {
  code=$?
  [ "$code" -ne 0 ] || return 0
  [ "$COMMITTED" -eq 0 ] || exit "$code"
  trap - EXIT
  set +e
  echo "Stopped while $STEP."
  if [ "$MODE" = in-place ] && [ "$SWAPPED" -eq 1 ]; then
    OLD=$(jq -r .oldPv "$P")
    echo "Putting $CLAIM back on its old volume $OLD."
    scale_all zero
    wait_unmounted
    bound=$(k get pvc "$CLAIM" -o jsonpath='{.spec.volumeName}' 2>/dev/null || true)
    if [ "$bound" != "$OLD" ]; then
      [ -z "$bound" ] || k delete pvc "$CLAIM" --wait=true
      kubectl patch pv "$OLD" --type=json -p '[{"op":"remove","path":"/spec/claimRef"}]' >/dev/null || true
      k create -f /values/old.json
      wait_bound "$CLAIM"
    fi
    pv_policy "$OLD" "$(jq -r .oldReclaim "$P")"
    discard_new
    scale_all back
    echo "Error while $STEP: $CLAIM is back on its old volume and nothing was deleted."
  elif [ "$MODE" = in-place ] && [ "$(jq 'has("oldPv")' "$P")" = true ]; then
    pv_policy "$(jq -r .oldPv "$P")" "$(jq -r .oldReclaim "$P")"
    discard_new
    scale_all back
    echo "Error while $STEP: $CLAIM was not touched; the restored volume was discarded."
  else
    k delete pvc "$CLAIM" --ignore-not-found --wait=false >/dev/null 2>&1 || true
    discard_new
    echo "Error while $STEP: the restored volume was discarded; nothing else changed."
  fi
  exit 1
}
trap on_exit EXIT

STEP="restoring $(jq -r .backup "$P")"
echo "+ Restoring $(jq -r .backup "$P") into Longhorn volume $VOL"
lh create -f /values/volume.json
wait_restored
kubectl create -f /values/pv.json

if [ "$MODE" = new-pvc ]; then
  STEP="binding $CLAIM"
  echo "+ Binding $CLAIM to it"
  k create -f /values/claim.json
  wait_bound "$CLAIM"
  COMMITTED=1
  pv_policy "$VOL" Delete
  echo "Restored into $CLAIM in $NS; the original claim was not touched."
  exit 0
fi

OLD=$(jq -r .oldPv "$P")
STEP="stopping the workloads"
echo "+ Stopping what mounts $CLAIM"
pv_policy "$OLD" Retain
[ "$(kubectl get pv "$OLD" -o jsonpath='{.spec.persistentVolumeReclaimPolicy}')" = Retain ]
scale_all zero
wait_unmounted

STEP="switching $CLAIM to the restored volume"
echo "+ Switching $CLAIM to the restored volume"
SWAPPED=1
k delete pvc "$CLAIM" --wait=true
k create -f /values/claim.json
wait_bound "$CLAIM"

STEP="starting the workloads"
echo "+ Starting them again"
scale_all back
jq -r '.workloads[] | "\\(.kind) \\(.name)"' "$P" | while read -r kind name; do
  k rollout status "$kind/$name" --timeout=10m
done
COMMITTED=1

pv_policy "$VOL" Delete
echo "+ Deleting the volume it replaced"
pv_policy "$OLD" "$(jq -r .oldReclaim "$P")"
echo "Restored $CLAIM in place from $(jq -r .backup "$P")."
`;

export const restoreAction: ActionRecipe<LonghornRestoreAction> = {
  kind: KIND,

  async render(request, ctx): Promise<ActionRendered> {
    const base = longhornBase(ctx);
    const target = request.mode === "in-place" ? request.claim : (request.newClaim ?? "");
    const title =
      request.mode === "in-place"
        ? `Restore ${request.namespace}/${request.claim} in place`
        : `Restore ${request.namespace}/${request.claim} to ${target}`;
    const refused = refuse(KIND, title, ctx);
    if (refused) return refused;
    const k8s = ctx.k8s!;
    const block = (reason: string) => blockedAction(KIND, title, base, reason);

    if (request.mode === "new-pvc" && !CLAIM_NAME.test(target)) {
      return block("newClaim must be a lowercase DNS name of at most 253 characters.");
    }
    const volume = await volumeOfClaim(k8s, request.namespace, request.claim);
    if (volume === "absent") return block(NOT_INSTALLED);
    if (!volume) return block(`${request.namespace}/${request.claim} is not a Longhorn volume.`);
    const backup = await k8s.get<LonghornBackup>(RESOURCES.longhornBackups, request.backup, LONGHORN_NAMESPACE);
    if (backup === "absent") return block(NOT_INSTALLED);
    if (!backup) return block(`No backup "${request.backup}" on the target.`);
    const from = backup.status?.volumeName ?? backup.metadata.labels?.["backup-volume"];
    if (from && from !== volume.metadata.name) {
      return block(`Backup ${request.backup} is of volume ${from}, not of ${request.namespace}/${request.claim}.`);
    }
    if (backup.status?.state !== "Completed" || !backup.status.url) {
      return block(`Backup ${request.backup} is not complete (${backup.status?.state ?? "no state"}).`);
    }
    const claim = (await k8s.get(RESOURCES.pvcs, request.claim, request.namespace)) as PvcLike | null | "absent";
    if (!claim || claim === "absent") return block(`Claim ${request.namespace}/${request.claim} was not found.`);
    if (request.mode === "new-pvc") {
      const exists = await k8s.get(RESOURCES.pvcs, target, request.namespace);
      if (exists && exists !== "absent")
        return block(`A claim named ${target} already exists in ${request.namespace}.`);
    }

    const sizeBytes = backup.status.volumeSize ?? String(parseQuantity(claim.spec?.resources?.requests?.storage) ?? "");
    if (!sizeBytes) return block(`The size of ${request.claim} could not be read.`);
    const runId = newRunId();
    const newVolume = restoredVolumeName(runId);
    const warnings: string[] = [];
    const steps: DeployActionStep[] = [
      {
        label: `Restore ${request.backup} into a new Longhorn volume`,
        commands: [display(["kubectl", "create", "--namespace", LONGHORN_NAMESPACE, "-f", "volume.json"])],
      },
    ];
    const creates: PlannedObject[] = [
      { kind: "Volume", name: newVolume, namespace: LONGHORN_NAMESPACE },
      { kind: "PersistentVolume", name: newVolume },
    ];
    const changes: PlannedObject[] = [];
    const bytes = Number(sizeBytes);
    const size = Number.isFinite(bytes) && bytes > 0 ? formatBytes(bytes) : claim.spec?.resources?.requests?.storage;
    let workloads: RestoreWorkload[] = [];
    let downtime: string | undefined;
    let rollback: string;

    if (request.mode === "new-pvc") {
      steps.push({
        label: `Bind ${target} to it`,
        commands: [
          display(["kubectl", "create", "-f", "pv.json"]),
          display(["kubectl", "-n", request.namespace, "create", "-f", "claim.json"]),
        ],
      });
      creates.push({ kind: "PersistentVolumeClaim", name: target, namespace: request.namespace });
      warnings.push(
        `The app keeps using ${request.claim}; mount ${target} where you want the restored data, or restore in place.`
      );
      rollback = `The new volume and claim are deleted if a step fails; ${request.claim} is never touched.`;
    } else {
      const found = await claimWorkloads(k8s, request.namespace, request.claim);
      if (found.blockedBy) return block(found.blockedBy);
      workloads = found.workloads;
      if (!claim.spec?.volumeName) return block(`Claim ${request.claim} is not bound to a volume.`);
      const pv = (await k8s.get(RESOURCES.pvs, claim.spec.volumeName)) as
        (KubeObject & { spec?: { persistentVolumeReclaimPolicy?: string } }) | null | "absent";
      if (!pv || pv === "absent") return block(`Volume ${claim.spec.volumeName} was not found.`);
      const k = (...args: string[]) => display(["kubectl", "-n", request.namespace, ...args]);
      steps.push(
        {
          label: `Stop ${workloads.length > 0 ? workloads.map((w) => w.name).join(", ") : "nothing (no workload mounts it)"}`,
          commands: [
            display([
              "kubectl",
              "patch",
              "pv",
              claim.spec.volumeName,
              "-p",
              '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}',
            ]),
            ...workloads.map((w) => k("scale", `${w.kind}/${w.name}`, "--replicas=0")),
          ],
        },
        {
          label: `Switch ${request.claim} to the restored volume`,
          commands: [
            k("delete", "pvc", request.claim),
            display(["kubectl", "create", "-f", "pv.json"]),
            k("create", "-f", "claim.json"),
          ],
        },
        {
          label: "Start them again",
          commands: [
            ...workloads.map((w) => k("scale", `${w.kind}/${w.name}`, `--replicas=${w.replicas}`)),
            ...workloads.map((w) => k("rollout", "status", `${w.kind}/${w.name}`)),
          ],
        },
        {
          label: `Delete the volume it replaced (${claim.spec.volumeName})`,
          commands: [
            display([
              "kubectl",
              "patch",
              "pv",
              claim.spec.volumeName,
              "-p",
              `{"spec":{"persistentVolumeReclaimPolicy":"${pv.spec?.persistentVolumeReclaimPolicy ?? "Delete"}"}}`,
            ]),
          ],
        }
      );
      changes.push(
        ...workloads.map((w) => ({
          kind: w.kind === "deployment" ? "Deployment" : "StatefulSet",
          name: w.name,
          namespace: request.namespace,
        })),
        { kind: "PersistentVolumeClaim", name: request.claim, namespace: request.namespace },
        { kind: "PersistentVolume", name: claim.spec.volumeName }
      );
      const seconds = FIXED_DOWNTIME_SECONDS + (Number.isFinite(bytes) ? bytes / RESTORE_BYTES_PER_SECOND / 4 : 0);
      downtime =
        workloads.length > 0
          ? `${workloads.map((w) => w.name).join(", ")} ${workloads.length === 1 ? "is" : "are"} stopped for ${describeDowntime(seconds)} while the claim is switched; the restore itself runs before they stop.`
          : undefined;
      warnings.push(
        `Everything written to ${request.claim} since the backup (${backup.status.snapshotCreatedAt ?? "its time unknown"}) is replaced by the backup's data once the app is back up.`
      );
      if (workloads.length === 0) warnings.push(`No Deployment or StatefulSet mounts ${request.claim}.`);
      rollback =
        "Until the app is back up on the restored volume, a failed step puts the claim back on its old volume and " +
        "starts the app again; the old volume is deleted only after that.";

      return {
        ...base,
        plan: {
          kind: KIND,
          title,
          allowed: true,
          steps,
          ...(downtime ? { downtime } : {}),
          rollback,
          changes,
          creates,
          warnings,
          volumes: [
            {
              namespace: request.namespace,
              claim: request.claim,
              storageClass: claim.spec.storageClassName ?? "",
              size: claim.spec.resources?.requests?.storage ?? size ?? "",
            },
          ],
        },
        steps: [],
        script: RESTORE_SCRIPT,
        deadlineSeconds: RESTORE_TIMEOUT_SECONDS + 1800,
        files: ctx.run
          ? restoreFiles({
              mode: "in-place",
              namespace: request.namespace,
              claim,
              boundClaim: request.claim,
              volume: newVolume,
              backupUrl: backup.status.url,
              backupName: request.backup,
              sizeBytes,
              replicas: volume.spec?.numberOfReplicas ?? 2,
              accessMode: volume.spec?.accessMode,
              dataEngine: volume.spec?.dataEngine,
              oldPv: claim.spec.volumeName,
              oldReclaim: pv.spec?.persistentVolumeReclaimPolicy ?? "Delete",
              workloads,
              labels: k8s.ownedLabels(),
            })
          : {},
      };
    }

    return {
      ...base,
      plan: {
        kind: KIND,
        title,
        allowed: true,
        steps,
        rollback,
        changes,
        creates,
        warnings,
        volumes: [
          {
            namespace: request.namespace,
            claim: request.claim,
            storageClass: claim.spec?.storageClassName ?? "",
            size: claim.spec?.resources?.requests?.storage ?? size ?? "",
          },
        ],
      },
      steps: [],
      script: RESTORE_SCRIPT,
      deadlineSeconds: RESTORE_TIMEOUT_SECONDS + 600,
      files: ctx.run
        ? restoreFiles({
            mode: "new-pvc",
            namespace: request.namespace,
            claim,
            boundClaim: target,
            volume: newVolume,
            backupUrl: backup.status.url,
            backupName: request.backup,
            sizeBytes,
            replicas: volume.spec?.numberOfReplicas ?? 2,
            accessMode: volume.spec?.accessMode,
            dataEngine: volume.spec?.dataEngine,
            workloads: [],
            labels: k8s.ownedLabels(),
          })
        : {},
    };
  },
};

import { randomBytes } from "node:crypto";
import type { CatalogEntry, DiscoveryReport } from "../../../contracts/catalog.js";
import type {
  ActionVolume,
  DeployActionKind,
  DeployActionStep,
  MigrateToLonghornAction,
  PlannedObject,
} from "../../../contracts/deploy.js";
import { formatBytes } from "../../../contracts/disk.js";
import { RESOURCES, type K8sApi, type KubeObject } from "../../../contracts/k8s.js";
import { product } from "../../../product.js";
import { display, HELM_TIMEOUT } from "../plan.js";
import type { ActionContext, ActionRecipe, ActionRendered } from "./index.js";

// Moving an app's local-path volumes to Longhorn under the same claim names,
// so Helm releases and StatefulSets keep pointing at them with no values
// change. The old PersistentVolume is set to Retain before its claim goes and
// is deleted only after the app is back up on the copy and answers.

export const LOCAL_PATH_PROVISIONER = "rancher.io/local-path";
export const LONGHORN_PROVISIONER = "driver.longhorn.io";
// Labels the copy and backup Jobs in the app's namespace carry, by job id.
export const MIGRATE_LABEL = `${product.ownerMarker.labelDomain}/volume-migrate`;
export const BACKUP_LABEL = `${product.ownerMarker.labelDomain}/volume-backup`;

// Values keys that set the storage class of a PersistentVolumeClaim the
// chart templates itself. Helm's three-way merge would otherwise try to put
// the old class back on the next upgrade, and a claim's class is immutable.
// Claims a StatefulSet makes from its volumeClaimTemplates are not in the
// release manifest, and changing the template is refused, so those keys are
// left alone.
export const CHART_STORAGE_KEYS: Readonly<Record<string, readonly string[]>> = {
  gitea: ["persistence.storageClass"],
  grafana: ["persistence.storageClassName"],
};

// Rough copy throughput on a homelab disk, for the downtime estimate and the
// copy Job's timeout; the timeout allows a fifth of it.
const COPY_BYTES_PER_SECOND = 50 * 1024 ** 2;
const MIN_COPY_TIMEOUT_SECONDS = 600;
const FIXED_DOWNTIME_SECONDS = 90;
// Whole run: stopping, every copy, starting, the check, the cleanup.
const BASE_DEADLINE_SECONDS = 1800;

const UNITS: Record<string, number> = {
  "": 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
};

export function parseQuantity(value: string | undefined): number | undefined {
  const match = /^([0-9]+(?:\.[0-9]+)?)([kMGTP]i?|)$/.exec(value?.trim() ?? "");
  if (!match) return undefined;
  return Math.round(Number(match[1]) * UNITS[match[2]!]!);
}

export type WorkloadKind = "deployment" | "statefulset";

export interface MigrateWorkload {
  kind: WorkloadKind;
  name: string;
  replicas: number;
}

export interface MigrateVolume {
  namespace: string;
  claim: string;
  pv: string;
  storageClass: string;
  // The claim's requested size, as written ("5Gi").
  size: string;
  sizeBytes: number;
  // What the kubelet reports in use, when a running pod mounts it.
  usedBytes?: number;
  // The node the local-path data lives on.
  node?: string;
  reclaimPolicy: string;
  // The temporary Longhorn claim the data is copied into first.
  tmpClaim: string;
  copyJob: string;
}

export interface MigrateInspection {
  appId: string;
  release: string;
  namespace: string;
  allowed: boolean;
  blockedBy?: string;
  targetStorageClass?: string;
  volumes: MigrateVolume[];
  workloads: MigrateWorkload[];
  // The claims as read, by name, for the files the Job recreates them from.
  claims: Record<string, KubeObject>;
  // Probed after the app is back up; the in-cluster Service URL of its UI.
  checkUrl?: string;
  // `--set key=<class>` pairs recorded in the Helm release afterwards.
  helmSet: string[];
  helmArgv?: string[];
  downtimeSeconds: number;
  copyTimeoutSeconds: number;
  // Free space Longhorn reports across its schedulable disks.
  longhornAvailableBytes?: number;
  // Nodes Longhorn can put replicas on; above 1, raising replicas is offered.
  longhornNodes: number;
  warnings: string[];
}

interface PvcSpec {
  storageClassName?: string;
  volumeName?: string;
  accessModes?: string[];
  volumeMode?: string;
  resources?: { requests?: { storage?: string } };
}

interface PvSpec {
  persistentVolumeReclaimPolicy?: string;
  storageClassName?: string;
  nodeAffinity?: {
    required?: { nodeSelectorTerms?: Array<{ matchExpressions?: Array<{ key?: string; values?: string[] }> }> };
  };
}

interface PodSpecLike {
  volumes?: Array<{ persistentVolumeClaim?: { claimName?: string } }>;
}

const list = async (k8s: K8sApi, ref: (typeof RESOURCES)[keyof typeof RESOURCES], namespace?: string) => {
  const found = await k8s.list(ref, namespace ? { namespace } : {});
  return found === "absent" ? [] : found;
};

const claimNames = (spec: PodSpecLike | undefined): string[] =>
  (spec?.volumes ?? []).flatMap((v) => (v.persistentVolumeClaim?.claimName ? [v.persistentVolumeClaim.claimName] : []));

function belongsTo(obj: KubeObject, release: string): boolean {
  const labels = obj.metadata.labels ?? {};
  return (
    labels["app.kubernetes.io/instance"] === release ||
    labels.release === release ||
    obj.metadata.annotations?.["meta.helm.sh/release-name"] === release
  );
}

function pvNode(spec: PvSpec): string | undefined {
  for (const term of spec.nodeAffinity?.required?.nodeSelectorTerms ?? []) {
    for (const expr of term.matchExpressions ?? []) {
      if (expr.key === "kubernetes.io/hostname" && expr.values?.[0]) return expr.values[0];
    }
  }
  return undefined;
}

// Kubelet stats are best effort: a claim no running pod mounts has none.
async function usage(k8s: K8sApi, nodes: Set<string>): Promise<Map<string, number>> {
  const used = new Map<string, number>();
  await Promise.all(
    [...nodes].map(async (node) => {
      try {
        const summary = (await k8s.raw(`/api/v1/nodes/${encodeURIComponent(node)}/proxy/stats/summary`)) as {
          pods?: Array<{ volume?: Array<{ usedBytes?: number; pvcRef?: { name?: string; namespace?: string } }> }>;
        };
        for (const pod of summary.pods ?? []) {
          for (const volume of pod.volume ?? []) {
            const ref = volume.pvcRef;
            if (ref?.name && ref.namespace && typeof volume.usedBytes === "number") {
              used.set(`${ref.namespace}/${ref.name}`, volume.usedBytes);
            }
          }
        }
      } catch {
        // Unknown usage: the estimate falls back to the claim's size.
      }
    })
  );
  return used;
}

function pickLonghornClass(classes: KubeObject[]): KubeObject | undefined {
  const longhorn = classes.filter((sc) => (sc as { provisioner?: string }).provisioner === LONGHORN_PROVISIONER);
  return (
    longhorn.find((sc) => sc.metadata.name === "longhorn") ??
    longhorn.find((sc) => sc.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true") ??
    longhorn[0]
  );
}

interface LonghornNodeStatus {
  conditions?: Array<{ type?: string; status?: string }>;
  diskStatus?: Record<string, { storageAvailable?: number; conditions?: Array<{ type?: string; status?: string }> }>;
}

function longhornCapacity(nodes: KubeObject[]): { available?: number; schedulable: number } {
  let available: number | undefined;
  let schedulable = 0;
  for (const node of nodes) {
    const spec = (node.spec ?? {}) as { allowScheduling?: boolean };
    const status = (node.status ?? {}) as LonghornNodeStatus;
    const ready = status.conditions?.some((c) => c.type === "Schedulable" && c.status === "True") ?? true;
    if (spec.allowScheduling === false || !ready) continue;
    schedulable++;
    for (const disk of Object.values(status.diskStatus ?? {})) {
      if (typeof disk.storageAvailable === "number") available = (available ?? 0) + disk.storageAvailable;
    }
  }
  return { available, schedulable };
}

const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));

export function describeDowntime(seconds: number): string {
  const m = minutes(seconds);
  return m < 60 ? `about ${m} minute${m === 1 ? "" : "s"}` : `about ${(m / 60).toFixed(1).replace(/\.0$/, "")} hours`;
}

const dnsName = (value: string, max = 63) => value.slice(0, max).replace(/-+$/, "");

export interface InspectInput {
  k8s: K8sApi;
  appId: string;
  release: string;
  namespace: string;
  entry?: CatalogEntry;
  discovery?: DiscoveryReport;
  // The chart version installed, for recording the class in the release.
  chartVersion?: string;
  // Unique per run, for the copy Jobs' names.
  runId: string;
}

// Reads only. Everything the Job needs is captured here and handed to it as
// files, so the plan the user saw is what runs.
export async function inspectMigration(input: InspectInput): Promise<MigrateInspection> {
  const { k8s, appId, release, namespace } = input;
  const result: MigrateInspection = {
    appId,
    release,
    namespace,
    allowed: false,
    volumes: [],
    workloads: [],
    claims: {},
    helmSet: [],
    downtimeSeconds: 0,
    copyTimeoutSeconds: MIN_COPY_TIMEOUT_SECONDS,
    longhornNodes: 0,
    warnings: [],
  };
  const block = (reason: string) => ({ ...result, allowed: false, blockedBy: reason });

  const [classes, deployments, statefulSets, pods, pvcs, pvs, longhornNodes] = await Promise.all([
    list(k8s, RESOURCES.storageClasses),
    list(k8s, RESOURCES.deployments, namespace),
    list(k8s, RESOURCES.statefulSets, namespace),
    list(k8s, RESOURCES.pods, namespace),
    list(k8s, RESOURCES.pvcs, namespace),
    list(k8s, RESOURCES.pvs),
    list(k8s, RESOURCES.longhornNodes),
  ]);

  const target = pickLonghornClass(classes);
  if (!target) return block("Longhorn is not installed: no storage class uses its provisioner.");
  result.targetStorageClass = target.metadata.name;
  const capacity = longhornCapacity(longhornNodes);
  result.longhornNodes = capacity.schedulable;
  result.longhornAvailableBytes = capacity.available;

  const provisioner = new Map(classes.map((sc) => [sc.metadata.name, (sc as { provisioner?: string }).provisioner]));
  const pvcByName = new Map(pvcs.map((pvc) => [pvc.metadata.name, pvc]));
  const pvByName = new Map(pvs.map((pv) => [pv.metadata.name, pv]));

  // Claims each workload of the release mounts, StatefulSet templates included.
  const mounted = new Map<string, string>();
  for (const d of deployments.filter((obj) => belongsTo(obj, release))) {
    const spec = d.spec as { replicas?: number; template?: { spec?: PodSpecLike } };
    result.workloads.push({ kind: "deployment", name: d.metadata.name, replicas: spec.replicas ?? 1 });
    for (const claim of claimNames(spec.template?.spec)) mounted.set(claim, `Deployment ${d.metadata.name}`);
  }
  for (const s of statefulSets.filter((obj) => belongsTo(obj, release))) {
    const spec = s.spec as {
      replicas?: number;
      template?: { spec?: PodSpecLike };
      volumeClaimTemplates?: Array<{ metadata?: { name?: string } }>;
    };
    const replicas = spec.replicas ?? 1;
    result.workloads.push({ kind: "statefulset", name: s.metadata.name, replicas });
    for (const claim of claimNames(spec.template?.spec)) mounted.set(claim, `StatefulSet ${s.metadata.name}`);
    for (const t of spec.volumeClaimTemplates ?? []) {
      for (let i = 0; i < replicas; i++) {
        if (t.metadata?.name)
          mounted.set(`${t.metadata.name}-${s.metadata.name}-${i}`, `StatefulSet ${s.metadata.name}`);
      }
    }
  }
  if (result.workloads.length === 0) {
    return block(`No Deployment or StatefulSet of release ${release} was found in ${namespace}.`);
  }

  const kept: string[] = [];
  let helmManaged = false;
  for (const claim of [...mounted.keys()].toSorted()) {
    const pvc = pvcByName.get(claim);
    if (!pvc) continue;
    const spec = (pvc.spec ?? {}) as PvcSpec;
    const className = spec.storageClassName ?? "";
    if (provisioner.get(className) !== LOCAL_PATH_PROVISIONER) {
      if (className !== result.targetStorageClass) kept.push(`${claim} (${className || "no class"})`);
      continue;
    }
    const phase = (pvc.status as { phase?: string } | undefined)?.phase;
    const pv = spec.volumeName ? pvByName.get(spec.volumeName) : undefined;
    if (phase !== "Bound" || !pv) return block(`Claim ${claim} is not bound to a volume (${phase ?? "unknown"}).`);
    if (spec.volumeMode === "Block")
      return block(`Claim ${claim} is a raw block volume; only filesystem volumes are copied.`);
    const sizeBytes = parseQuantity(spec.resources?.requests?.storage);
    if (!sizeBytes) return block(`Claim ${claim} has no readable size.`);
    if (pvc.metadata.annotations?.["meta.helm.sh/release-name"] === release) helmManaged = true;
    const pvSpec = (pv.spec ?? {}) as PvSpec;
    const n = result.volumes.length;
    result.claims[claim] = pvc;
    result.volumes.push({
      namespace,
      claim,
      pv: pv.metadata.name,
      storageClass: className,
      size: spec.resources!.requests!.storage!,
      sizeBytes,
      node: pvNode(pvSpec),
      reclaimPolicy: pvSpec.persistentVolumeReclaimPolicy ?? "Delete",
      tmpClaim: dnsName(`${claim}-longhorn`, 253),
      copyJob: dnsName(`${release}-copy-${input.runId}-${n}`),
    });
  }
  if (result.volumes.length === 0) {
    return block(
      kept.length > 0
        ? `None of its volumes are on local-path (${kept.join(", ")}).`
        : `${appId} has no local-path volumes to convert.`
    );
  }
  if (kept.length > 0) result.warnings.push(`Left as they are, not on local-path: ${kept.join(", ")}.`);

  for (const v of result.volumes) {
    if (pvcByName.has(v.tmpClaim)) return block(`A claim named ${v.tmpClaim} already exists in ${namespace}.`);
  }

  // Anything else mounting these claims would hold them while they are swapped.
  const workloadNames = new Set(result.workloads.map((w) => w.name));
  const claimSet = new Set(result.volumes.map((v) => v.claim));
  for (const pod of pods) {
    const users = claimNames(pod.spec as PodSpecLike).filter((c) => claimSet.has(c));
    if (users.length === 0) continue;
    const owner = pod.metadata.ownerReferences?.[0];
    const ownerName = owner?.kind === "ReplicaSet" ? owner.name.replace(/-[a-z0-9]+$/, "") : owner?.name;
    const label = pod.metadata.labels?.[BACKUP_LABEL];
    if (label) continue;
    if (!ownerName || !workloadNames.has(ownerName)) {
      return block(`Pod ${pod.metadata.name} also mounts ${users.join(", ")} and can't be stopped from here.`);
    }
  }

  const used = await usage(k8s, new Set(result.volumes.flatMap((v) => (v.node ? [v.node] : []))));
  let copyBytes = 0;
  for (const v of result.volumes) {
    const u = used.get(`${namespace}/${v.claim}`);
    if (u !== undefined) v.usedBytes = u;
    // local-path doesn't enforce a claim's size, so the data can outgrow it;
    // the Longhorn copy can't.
    if (u !== undefined && u > v.sizeBytes) {
      return block(`Claim ${v.claim} holds more data than its size (${v.size}), so it would not fit on Longhorn.`);
    }
    copyBytes += u ?? v.sizeBytes;
  }
  const copySeconds = copyBytes / COPY_BYTES_PER_SECOND;
  result.downtimeSeconds = Math.round(FIXED_DOWNTIME_SECONDS * result.volumes.length + copySeconds);
  result.copyTimeoutSeconds = Math.max(MIN_COPY_TIMEOUT_SECONDS, Math.round(copySeconds * 5));

  if (capacity.available !== undefined) {
    const replicas = Math.max(1, Math.min(capacity.schedulable, longhornReplicaCount(target)));
    const need = result.volumes.reduce((sum, v) => sum + v.sizeBytes, 0) * replicas;
    if (need > capacity.available) {
      result.warnings.push(
        `Longhorn reports less free space than these volumes reserve (${replicas} replica${replicas === 1 ? "" : "s"} each); the copy may not fit.`
      );
    }
  }
  if (result.volumes.some((v) => v.usedBytes === undefined)) {
    result.warnings.push("Some volumes' usage could not be read, so the downtime estimate assumes they are full.");
  }

  if (helmManaged) {
    const keys = CHART_STORAGE_KEYS[appId];
    const install = input.entry?.install;
    if (!keys || install?.kind !== "helm" || !input.chartVersion) {
      return block(
        `Its chart creates the claim itself and this version can't tell which value sets its storage class, so the next upgrade would fail.`
      );
    }
    result.helmSet = keys.map((key) => `${key}=${result.targetStorageClass}`);
    const oci = install.repo.startsWith("oci://");
    result.helmArgv = [
      "helm",
      "upgrade",
      release,
      oci ? `${install.repo.replace(/\/+$/, "")}/${install.chart}` : install.chart,
      ...(oci ? [] : ["--repo", install.repo]),
      "--version",
      input.chartVersion,
      "--namespace",
      namespace,
      "--reuse-values",
      ...result.helmSet.flatMap((pair) => ["--set", pair]),
      "--wait",
      "--timeout",
      HELM_TIMEOUT,
    ];
  }

  result.checkUrl = input.discovery?.ingressHosts.find(
    (h) => h.appId === appId && h.namespace === namespace && h.serviceUrl
  )?.serviceUrl;
  if (!result.checkUrl) {
    result.warnings.push("No Service URL was found for it, so success is judged on its pods becoming ready.");
  }
  result.allowed = true;
  return result;
}

function longhornReplicaCount(sc: KubeObject): number {
  const value = Number((sc as { parameters?: Record<string, string> }).parameters?.numberOfReplicas ?? "3");
  return Number.isInteger(value) && value > 0 ? value : 3;
}

export function deadlineSeconds(i: MigrateInspection): number {
  return BASE_DEADLINE_SECONDS + i.copyTimeoutSeconds * i.volumes.length;
}

// Annotations the control plane writes on a bound claim; a fresh claim must
// not carry them.
const BINDING_ANNOTATIONS = /^(pv\.kubernetes\.io\/|volume\.beta\.kubernetes\.io\/|volume\.kubernetes\.io\/)/;

function claimObject(old: KubeObject, storageClass: string, volumeName?: string): KubeObject {
  const spec = (old.spec ?? {}) as PvcSpec;
  const annotations = Object.fromEntries(
    Object.entries(old.metadata.annotations ?? {}).filter(([key]) => !BINDING_ANNOTATIONS.test(key))
  );
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: old.metadata.name,
      namespace: old.metadata.namespace,
      ...(old.metadata.labels ? { labels: old.metadata.labels } : {}),
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    },
    spec: {
      accessModes: spec.accessModes ?? ["ReadWriteOnce"],
      resources: { requests: { storage: spec.resources?.requests?.storage } },
      storageClassName: storageClass,
      ...(volumeName ? { volumeName } : {}),
    },
  };
}

export interface MigrateRenderOptions {
  // The deploy image (busybox cp, kubectl, helm, jq, curl).
  image: string;
  runId: string;
  ownedLabels: Record<string, string>;
}

// The Job's files: plan.json drives the fixed script; the rest are the
// objects it creates, rendered here so nothing is assembled in shell.
export function migrationFiles(i: MigrateInspection, options: MigrateRenderOptions): Record<string, string> {
  const target = i.targetStorageClass!;
  const files: Record<string, string> = {};
  const labels = { ...options.ownedLabels, [MIGRATE_LABEL]: options.runId };
  i.volumes.forEach((v, n) => {
    const old = i.claims[v.claim]!;
    files[`old-${n}.json`] = JSON.stringify(claimObject(old, v.storageClass, v.pv));
    files[`new-${n}.json`] = JSON.stringify(claimObject(old, target));
    files[`tmp-${n}.json`] = JSON.stringify({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: v.tmpClaim, namespace: i.namespace, labels },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: v.size } },
        storageClassName: target,
      },
    });
    files[`copy-${n}.json`] = JSON.stringify(copyJob(v, options.image, labels));
  });
  files["plan.json"] = JSON.stringify({
    app: i.appId,
    namespace: i.namespace,
    backupLabel: BACKUP_LABEL,
    copyTimeoutSeconds: i.copyTimeoutSeconds,
    workloads: i.workloads,
    volumes: i.volumes.map((v) => ({
      claim: v.claim,
      pv: v.pv,
      tmp: v.tmpClaim,
      copyJob: v.copyJob,
      reclaim: v.reclaimPolicy,
    })),
    ...(i.checkUrl ? { checkUrl: i.checkUrl } : {}),
    ...(i.helmArgv ? { helm: i.helmArgv } : {}),
  });
  return files;
}

// Root, so ownership and modes come across as they are; only the
// capabilities a copy needs.
function copyJob(v: MigrateVolume, image: string, labels: Record<string, string>): KubeObject {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: v.copyJob, namespace: v.namespace, labels },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          containers: [
            {
              name: "copy",
              image,
              command: ["/bin/sh", "-c", COPY_SCRIPT],
              securityContext: {
                runAsUser: 0,
                runAsGroup: 0,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"], add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID"] },
              },
              resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { memory: "256Mi" } },
              volumeMounts: [
                { name: "from", mountPath: "/from", readOnly: true },
                { name: "to", mountPath: "/to" },
              ],
            },
          ],
          volumes: [
            { name: "from", persistentVolumeClaim: { claimName: v.claim, readOnly: true } },
            { name: "to", persistentVolumeClaim: { claimName: v.tmpClaim } },
          ],
        },
      },
    },
  };
}

// Counts entries on both sides so a short copy fails here, not in the app.
export const COPY_SCRIPT = `set -eu
cp -a /from/. /to/
a=$(find /from | wc -l); b=$(find /to | wc -l)
echo "Copied $((a - 1)) files and directories ($(du -sh /to | cut -f1))."
[ "$a" -le "$b" ] || { echo "error: the copy has $b entries, the source $a"; exit 1; }
`;

// The whole conversion. Fixed; every name it uses comes from /values/plan.json
// and the object files beside it. Until the old volumes are deleted, any
// failure scales the app down, rebinds each claim to its old volume (kept by
// the Retain policy) and scales it back up.
export const MIGRATE_SCRIPT = `set -eu
P=/values/plan.json
NS=$(jq -r .namespace "$P")
APP=$(jq -r .app "$P")
COUNT=$(jq '.volumes | length' "$P")
CLAIMS=$(jq -c '[.volumes[].claim]' "$P")
STEP="starting"
COMMITTED=0

k() { kubectl -n "$NS" "$@"; }
vol() { jq -r ".volumes[$1].$2" "$P"; }
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
    n=$(k get pods -o json | jq --argjson c "$CLAIMS" \\
      '[.items[] | select(any(.spec.volumes[]?; (.persistentVolumeClaim.claimName // "") as $n | $c | index($n)))] | length')
    [ "$n" -eq 0 ] && return 0
    tries=$((tries + 1))
    [ "$tries" -lt 120 ] || { echo "error: pods still use the volumes after 10 minutes"; return 1; }
    sleep 5
  done
}

wait_job() {
  end=$(($(date +%s) + $2))
  while :; do
    s=$(k get job "$1" -o jsonpath='{.status.succeeded}/{.status.failed}')
    case "$s" in
      1/*) k logs "job/$1" --tail=5 || true; return 0 ;;
      */[1-9]*) k logs "job/$1" --tail=20 || true; echo "error: copy job $1 failed"; return 1 ;;
    esac
    [ "$(date +%s)" -lt "$end" ] || { echo "error: copy job $1 did not finish in time"; return 1; }
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

restore() {
  claim=$(vol "$1" claim); old=$(vol "$1" pv); tmp=$(vol "$1" tmp)
  k delete job "$(vol "$1" copyJob)" --ignore-not-found --wait=true
  bound=$(k get pvc "$claim" -o jsonpath='{.spec.volumeName}' 2>/dev/null || true)
  if [ "$bound" != "$old" ]; then
    if [ -n "$bound" ]; then
      k delete pvc "$claim" --wait=true
      pv_policy "$bound" Delete
    fi
    kubectl patch pv "$old" --type=json -p '[{"op":"remove","path":"/spec/claimRef"}]' >/dev/null || true
    k create -f "/values/old-$1.json"
    wait_bound "$claim"
  fi
  k delete pvc "$tmp" --ignore-not-found --wait=false
  if [ -s "/tmp/tmppv-$1" ]; then pv_policy "$(cat "/tmp/tmppv-$1")" Delete || true; fi
  pv_policy "$old" "$(vol "$1" reclaim)"
  echo "$claim is on its old volume $old again."
}

on_exit() {
  code=$?
  [ "$code" -ne 0 ] || return 0
  [ "$COMMITTED" -eq 0 ] || exit "$code"
  trap - EXIT
  set +e
  echo "Stopped while $STEP; putting $APP back on its old volumes."
  scale_all zero
  wait_unmounted
  r=0
  while [ "$r" -lt "$COUNT" ]; do restore "$r"; r=$((r + 1)); done
  scale_all back
  echo "Error while $STEP: $APP is back on its old volumes and nothing was deleted."
  exit 1
}
trap on_exit EXIT

STEP="removing an earlier backup"
k delete job,secret -l "$(jq -r .backupLabel "$P")" --ignore-not-found --wait=true

STEP="stopping $APP"
echo "+ Stopping $APP"
scale_all zero
wait_unmounted

i=0
while [ "$i" -lt "$COUNT" ]; do
  claim=$(vol "$i" claim); old=$(vol "$i" pv); tmp=$(vol "$i" tmp); job=$(vol "$i" copyJob)
  STEP="copying $claim"
  echo "+ Copying $claim to Longhorn"
  k create -f "/values/tmp-$i.json"
  k create -f "/values/copy-$i.json"
  wait_job "$job" "$(jq -r .copyTimeoutSeconds "$P")"
  k delete job "$job" --wait=true
  tmppv=$(k get pvc "$tmp" -o jsonpath='{.spec.volumeName}')
  echo "$tmppv" > "/tmp/tmppv-$i"

  STEP="switching $claim to Longhorn"
  echo "+ Switching $claim to the copy"
  pv_policy "$tmppv" Retain
  pv_policy "$old" Retain
  [ "$(kubectl get pv "$old" -o jsonpath='{.spec.persistentVolumeReclaimPolicy}')" = Retain ]
  [ "$(kubectl get pv "$tmppv" -o jsonpath='{.spec.persistentVolumeReclaimPolicy}')" = Retain ]
  k delete pvc "$claim" --wait=true
  k delete pvc "$tmp" --wait=true
  kubectl patch pv "$tmppv" --type=json -p '[{"op":"remove","path":"/spec/claimRef"}]' >/dev/null
  jq --arg pv "$tmppv" '.spec.volumeName = $pv' "/values/new-$i.json" > "/tmp/new-$i.json"
  k create -f "/tmp/new-$i.json"
  wait_bound "$claim"
  pv_policy "$tmppv" Delete
  i=$((i + 1))
done

STEP="starting $APP"
echo "+ Starting $APP"
scale_all back
jq -r '.workloads[] | "\\(.kind) \\(.name)"' "$P" | while read -r kind name; do
  k rollout status "$kind/$name" --timeout=10m
done

URL=$(jq -r '.checkUrl // empty' "$P")
if [ -n "$URL" ]; then
  STEP="checking $APP answers"
  echo "+ Checking $URL"
  n=0
  until code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$URL") && [ "$code" -ge 200 ] && [ "$code" -lt 500 ]; do
    n=$((n + 1))
    [ "$n" -lt 30 ] || { echo "error: $URL did not answer (last status \${code:-none})"; exit 1; }
    sleep 10
  done
  echo "$URL answered $code."
fi
COMMITTED=1

echo "+ Deleting the old local-path volumes"
i=0
while [ "$i" -lt "$COUNT" ]; do pv_policy "$(vol "$i" pv)" Delete; i=$((i + 1)); done
i=0
while [ "$i" -lt "$COUNT" ]; do
  old=$(vol "$i" pv); n=0
  while kubectl get pv "$old" >/dev/null 2>&1; do
    n=$((n + 1))
    if [ "$n" -ge 24 ]; then echo "Warning: volume $old is still there; delete it with: kubectl delete pv $old"; break; fi
    sleep 5
  done
  i=$((i + 1))
done

if [ "$(jq 'has("helm")' "$P")" = true ]; then
  echo "+ Recording the storage class in the Helm release"
  eval "set -- $(jq -r '.helm | @sh' "$P")"
  if ! "$@" >/tmp/helm.log 2>&1; then
    tail -5 /tmp/helm.log
    echo "Warning: the release still names the old storage class; its next upgrade may fail until that value is changed."
  fi
fi

echo "Converted $COUNT volume(s) of $APP to Longhorn; the old local-path volumes were deleted."
`;

// --- the action ----------------------------------------------------------------

export interface AppTarget {
  appId: string;
  name: string;
  release: string;
  namespace: string;
  version: string;
  entry?: CatalogEntry;
}

export const newRunId = () => randomBytes(3).toString("hex");

// The app as this product deployed it: only those are converted from here.
export function appTarget(appId: string, ctx: ActionContext): AppTarget | string {
  const entry = ctx.catalog?.get(appId);
  const name = entry?.name ?? appId;
  const ours = ctx.releases.find((r) => r.appId === appId && r.state === "succeeded");
  if (!ours) return `${name} was not deployed from here, so its volumes can't be moved from here.`;
  return {
    appId,
    name,
    release: ours.release,
    namespace: ours.namespace,
    version: ctx.versions.get(ours.release) ?? "",
    ...(entry ? { entry } : {}),
  };
}

export function actionVolumes(i: MigrateInspection): ActionVolume[] {
  return i.volumes.map((v) => ({
    namespace: v.namespace,
    claim: v.claim,
    storageClass: v.storageClass,
    size: v.size,
    ...(v.usedBytes !== undefined ? { usedBytes: v.usedBytes } : {}),
    ...(v.node ? { node: v.node } : {}),
    ...(i.targetStorageClass ? { targetStorageClass: i.targetStorageClass } : {}),
  }));
}

export function blockedAction(
  kind: DeployActionKind,
  title: string,
  base: Omit<ActionRendered, "plan" | "steps" | "files">,
  blockedBy: string,
  volumes?: ActionVolume[]
): ActionRendered {
  return {
    ...base,
    plan: {
      kind,
      title,
      allowed: false,
      blockedBy,
      steps: [],
      changes: [],
      creates: [],
      warnings: [],
      ...(volumes && volumes.length > 0 ? { volumes } : {}),
    },
    steps: [],
    files: {},
  };
}

const used = (v: MigrateVolume) =>
  v.usedBytes !== undefined ? `${formatBytes(v.usedBytes)} of ${v.size}` : `up to ${v.size}`;

function migrateSteps(t: AppTarget, i: MigrateInspection): DeployActionStep[] {
  const k = (...args: string[]) => display(["kubectl", "-n", i.namespace, ...args]);
  const steps: DeployActionStep[] = [
    {
      label: `Stop ${t.name}`,
      commands: i.workloads.map((w) => k("scale", `${w.kind}/${w.name}`, "--replicas=0")),
    },
  ];
  for (const v of i.volumes) {
    steps.push({
      label: `Copy ${v.claim} (${used(v)}) to Longhorn and switch the claim to the copy`,
      commands: [
        k("create", "-f", `${v.tmpClaim}.json`),
        k("create", "-f", `${v.copyJob}.json`),
        display(["kubectl", "patch", "pv", v.pv, "-p", '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}']),
        k("delete", "pvc", v.claim),
        k("create", "-f", `${v.claim}.json`),
      ],
    });
  }
  steps.push({
    label: i.checkUrl
      ? `Start ${t.name} and check ${i.checkUrl} answers`
      : `Start ${t.name} and wait for it to be ready`,
    commands: [
      ...i.workloads.map((w) => k("scale", `${w.kind}/${w.name}`, `--replicas=${w.replicas}`)),
      ...i.workloads.map((w) => k("rollout", "status", `${w.kind}/${w.name}`)),
      ...(i.checkUrl ? [display(["curl", i.checkUrl])] : []),
    ],
  });
  steps.push({
    label: "Delete the old local-path volumes",
    commands: i.volumes.map((v) =>
      display(["kubectl", "patch", "pv", v.pv, "-p", '{"spec":{"persistentVolumeReclaimPolicy":"Delete"}}'])
    ),
  });
  if (i.helmArgv) {
    steps.push({
      label: `Record the ${i.targetStorageClass} storage class in the Helm release`,
      commands: [display(i.helmArgv)],
    });
  }
  return steps;
}

export const migrateAction: ActionRecipe<MigrateToLonghornAction> = {
  kind: "migrate-to-longhorn",

  async render(request: MigrateToLonghornAction, ctx: ActionContext): Promise<ActionRendered> {
    const target = appTarget(request.appId, ctx);
    const title = `Convert ${ctx.catalog?.get(request.appId)?.name ?? request.appId} to Longhorn`;
    if (typeof target === "string") {
      return blockedAction(
        "migrate-to-longhorn",
        title,
        { appId: request.appId, release: request.appId, namespace: "", version: "" },
        target
      );
    }
    const base = { appId: target.appId, release: target.release, namespace: target.namespace, version: target.version };
    if (!ctx.k8s) return blockedAction("migrate-to-longhorn", title, base, "The Kubernetes API is not available.");
    const runId = newRunId();
    const i = await inspectMigration({
      k8s: ctx.k8s,
      appId: target.appId,
      release: target.release,
      namespace: target.namespace,
      entry: target.entry,
      discovery: await ctx.discover(),
      chartVersion: target.version || undefined,
      runId,
    });
    const volumes = actionVolumes(i);
    if (!i.allowed) return blockedAction("migrate-to-longhorn", title, base, i.blockedBy!, volumes);
    if (!ctx.enabled) {
      return blockedAction(
        "migrate-to-longhorn",
        title,
        base,
        `Deploys are off.${ctx.enableHint ? ` Turn them on with: ${ctx.enableHint}` : ""}`,
        volumes
      );
    }

    const changes: PlannedObject[] = [
      ...i.workloads.map((w) => ({
        kind: w.kind === "deployment" ? "Deployment" : "StatefulSet",
        name: w.name,
        namespace: i.namespace,
      })),
      ...i.volumes.map((v) => ({ kind: "PersistentVolumeClaim", name: v.claim, namespace: i.namespace })),
      ...i.volumes.map((v) => ({ kind: "PersistentVolume", name: v.pv })),
    ];
    const creates: PlannedObject[] = i.volumes.flatMap((v) => [
      { kind: "PersistentVolumeClaim", name: v.tmpClaim, namespace: i.namespace },
      { kind: "Job", name: v.copyJob, namespace: i.namespace },
    ]);
    return {
      ...base,
      plan: {
        kind: "migrate-to-longhorn",
        title,
        allowed: true,
        steps: migrateSteps(target, i),
        downtime: `${target.name} is stopped for ${describeDowntime(i.downtimeSeconds)} while its data is copied.`,
        rollback:
          `Until the old volumes are deleted, a failed step puts every claim back on its old volume and starts ` +
          `${target.name} again; nothing is deleted.`,
        changes,
        creates,
        warnings: i.warnings,
        volumes,
        offerReplicas: i.longhornNodes > 1,
      },
      steps: [],
      script: MIGRATE_SCRIPT,
      deadlineSeconds: deadlineSeconds(i),
      files: ctx.run ? migrationFiles(i, { image: ctx.image, runId, ownedLabels: ctx.k8s.ownedLabels() }) : {},
    };
  },
};

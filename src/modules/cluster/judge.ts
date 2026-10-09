import type { CheckResult, Status } from "../../contracts/health.js";
import type { K8sServerInfo, K8sVersion, KubeObject } from "../../contracts/k8s.js";
import type { LinkKind, LinkTarget, Linker } from "./links.js";
import type { Thresholds } from "./settings.js";

// Pure judgements over a snapshot of the cluster. Each check is one result
// for the whole cluster, so its id and history stay stable while the
// offending objects come and go; the offenders are its raw.

interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

interface ContainerStatus {
  name: string;
  restartCount?: number;
  ready?: boolean;
  state?: { waiting?: { reason?: string; message?: string } };
  lastState?: { terminated?: { exitCode?: number; reason?: string; finishedAt?: string } };
}

interface NodeObject extends KubeObject {
  spec?: { unschedulable?: boolean };
  status?: { conditions?: Condition[]; nodeInfo?: { kubeletVersion?: string } };
}

interface PodObject extends KubeObject {
  spec?: { nodeName?: string };
  status?: {
    phase?: string;
    conditions?: Condition[];
    containerStatuses?: ContainerStatus[];
    initContainerStatuses?: ContainerStatus[];
  };
}

interface PvcObject extends KubeObject {
  spec?: { storageClassName?: string; volumeName?: string };
  status?: { phase?: string };
}

interface CertificateObject extends KubeObject {
  spec?: { secretName?: string; dnsNames?: string[] };
  status?: {
    conditions?: Condition[];
    notAfter?: string;
    renewalTime?: string;
    lastFailureTime?: string;
    failedIssuanceAttempts?: number;
  };
}

export interface VolumeStat {
  namespace: string;
  name: string;
  node: string;
  usedBytes: number;
  capacityBytes: number;
}

export interface Snapshot {
  nodes: KubeObject[];
  pods: KubeObject[];
  pvcs: KubeObject[];
  certificates: KubeObject[] | "absent";
  version: K8sVersion | Error;
  // Undefined when the Kubernetes service does not offer serverInfo.
  serverInfo?: K8sServerInfo | Error;
  // Undefined when nothing could be read; errors name the nodes that failed.
  volumes: { stats: VolumeStat[]; errors: string[] };
}

export interface JudgeOptions {
  now: number;
  thresholds: Thresholds;
  link: Linker;
  // Restarts per container within the spike window; see RestartTracker.
  restartsInWindow: (pod: KubeObject, container: string) => number | undefined;
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const nsName = (o: KubeObject) =>
  o.metadata.namespace ? `${o.metadata.namespace}/${o.metadata.name}` : o.metadata.name;
const cond = (o: { status?: { conditions?: Condition[] } }, type: string) =>
  o.status?.conditions?.find((c) => c.type === type);
const ageMs = (o: KubeObject, now: number) => {
  const created = Date.parse(o.metadata.creationTimestamp ?? "");
  return Number.isNaN(created) ? 0 : now - created;
};
const minutes = (ms: number) => (ms >= 120 * MIN ? `${Math.floor(ms / (60 * MIN))}h` : `${Math.floor(ms / MIN)}m`);

interface Offender {
  object: KubeObject;
  status: Exclude<Status, "ok" | "unknown" | "absent">;
  text: string;
  raw: Record<string, unknown>;
}

const worst = (offenders: Offender[]): Status =>
  offenders.some((o) => o.status === "crit") ? "crit" : offenders.length ? "warn" : "ok";

const KINDS: Record<LinkKind, string> = {
  node: "Node",
  pod: "Pod",
  pvc: "PersistentVolumeClaim",
  certificate: "Certificate",
};

// Offenders are sorted worst first, so the detail and the deep link lead
// with the one that sets the status.
function summarise(
  base: { id: string; label: string; observedAt: string },
  offenders: Offender[],
  kind: LinkKind,
  link: Linker,
  ok: string,
  noun: string
): CheckResult {
  if (!offenders.length) return { ...base, status: "ok", value: 0, detail: ok };
  const sorted = offenders.toSorted((a, b) => (a.status === b.status ? 0 : a.status === "crit" ? -1 : 1));
  const first = sorted[0]!;
  const target: LinkTarget =
    sorted.length === 1
      ? {
          kind,
          name: first.object.metadata.name,
          ...(first.object.metadata.namespace ? { namespace: first.object.metadata.namespace } : {}),
        }
      : { kind };
  const deepLink = link(target);
  const more = sorted.length > 1 ? ` (+${sorted.length - 1} more ${noun})` : "";
  return {
    ...base,
    status: worst(sorted),
    value: sorted.length,
    detail: `${first.text}${more}`,
    raw: sorted.map((o) => ({ object: nsName(o.object), status: o.status, ...o.raw })),
    ...(deepLink ? { deepLink } : {}),
    object: {
      kind: KINDS[kind],
      ...(first.object.metadata.namespace ? { namespace: first.object.metadata.namespace } : {}),
      name: first.object.metadata.name,
    },
  };
}

const isReady = (node: KubeObject) => cond(node as NodeObject, "Ready")?.status === "True";

export function judgeNodes(nodes: KubeObject[], o: JudgeOptions, observedAt: string): CheckResult[] {
  const base = (id: string, label: string) => ({ id, label, observedAt });
  if (!nodes.length) {
    const none = { status: "unknown" as const, detail: "No nodes visible to this service account" };
    return [
      { ...base("nodes", "Nodes ready"), ...none },
      { ...base("node-pressure", "Node pressure"), ...none },
    ];
  }

  const notReady = nodes.map((n) => n as NodeObject).filter((n) => !isReady(n));
  const cordoned = nodes.filter((n) => (n as NodeObject).spec?.unschedulable).length;
  const readyCount = nodes.length - notReady.length;
  const readyLine = `${readyCount}/${nodes.length} nodes Ready${cordoned ? `, ${cordoned} cordoned` : ""}`;
  const nodesResult = summarise(
    base("nodes", "Nodes ready"),
    notReady.map((n) => {
      const ready = cond(n, "Ready");
      const why = ready
        ? `${ready.reason ?? ready.status}${ready.message ? `: ${ready.message}` : ""}`
        : "no Ready condition";
      return {
        object: n,
        status: "crit",
        text: `${n.metadata.name} NotReady (${why}); ${readyLine}`,
        raw: { ready: ready ?? null },
      };
    }),
    "node",
    o.link,
    readyLine,
    "nodes"
  );

  // A NotReady node's other conditions are stale (Unknown), so only Ready
  // nodes are judged for pressure.
  const pressure: Offender[] = [];
  for (const node of nodes.filter(isReady) as NodeObject[]) {
    const active = (node.status?.conditions ?? []).filter(
      (c) =>
        c.status === "True" && ["MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"].includes(c.type)
    );
    if (!active.length) continue;
    pressure.push({
      object: node,
      status: active.some((c) => c.type === "NetworkUnavailable") ? "crit" : "warn",
      text: `${node.metadata.name}: ${active.map((c) => c.type).join(", ")}${active[0]?.reason ? ` (${active[0].reason})` : ""}`,
      raw: { conditions: active },
    });
  }
  return [
    nodesResult,
    summarise(
      base("node-pressure", "Node pressure"),
      pressure,
      "node",
      o.link,
      `No memory, disk or PID pressure on ${plural(nodes.length - notReady.length, "Ready node")}`,
      "nodes"
    ),
  ];
}

const CRASH_REASONS = new Set([
  "CrashLoopBackOff",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
]);
const IMAGE_REASONS = new Set(["ErrImagePull", "ImagePullBackOff", "InvalidImageName", "ErrImageNeverPull"]);

function containers(pod: PodObject): ContainerStatus[] {
  return [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
}

const live = (pod: PodObject) => pod.status?.phase !== "Succeeded" && pod.status?.phase !== "Failed";

// A Job's pod restarts in place (restartPolicy OnFailure) until the Job's
// backoffLimit, 6 by default, and a pod that fails for good is Failed and no
// longer live. Install Jobs (k3s's helm-install-*) routinely fail once or
// twice while the API they install into comes up.
const JOB_QUIET_RESTARTS = 2;
const JOB_BACKOFF_LIMIT = 6;
// A brand-new pod's first crashes are often a dependency still starting.
const YOUNG_POD_MS = 5 * MIN;
const YOUNG_RESTARTS = 2;

const ownedByJob = (pod: PodObject) => (pod.metadata.ownerReferences ?? []).some((r) => r.kind === "Job");

// undefined: not worth reporting yet.
function crashStatus(pod: PodObject, restarts: number, now: number): "crit" | "warn" | undefined {
  if (ownedByJob(pod)) {
    if (restarts <= JOB_QUIET_RESTARTS) return undefined;
    return restarts < JOB_BACKOFF_LIMIT ? "warn" : "crit";
  }
  return ageMs(pod, now) < YOUNG_POD_MS && restarts <= YOUNG_RESTARTS ? "warn" : "crit";
}

export function judgePods(pods: KubeObject[], o: JudgeOptions, observedAt: string): CheckResult[] {
  const crash: Offender[] = [];
  const image: Offender[] = [];
  const pending: Offender[] = [];
  const spikes: Offender[] = [];
  const t = o.thresholds;

  for (const pod of (pods as PodObject[]).filter(live)) {
    let flagged = false;
    for (const c of containers(pod)) {
      const waiting = c.state?.waiting;
      const reason = waiting?.reason ?? "";
      const raw = { container: c.name, reason, message: waiting?.message, restarts: c.restartCount ?? 0 };
      if (CRASH_REASONS.has(reason)) {
        flagged = true;
        const status = crashStatus(pod, c.restartCount ?? 0, o.now);
        if (!status) break;
        const last = c.lastState?.terminated;
        const exit = last ? `; last exit ${last.exitCode ?? "?"}${last.reason ? ` (${last.reason})` : ""}` : "";
        const retrying = ownedByJob(pod) && status === "warn" ? "; its Job is still retrying" : "";
        crash.push({
          object: pod,
          status,
          text: `${nsName(pod)} ${c.name}: ${reason}, ${plural(c.restartCount ?? 0, "restart")}${exit}${retrying}`,
          raw: { ...raw, lastTerminated: last ?? null },
        });
        break;
      }
      if (IMAGE_REASONS.has(reason)) {
        image.push({
          object: pod,
          status: "crit",
          text: `${nsName(pod)} ${c.name}: ${reason}${waiting?.message ? ` (${waiting.message})` : ""}`,
          raw,
        });
        flagged = true;
        break;
      }
    }

    if (!flagged && pod.status?.phase === "Pending") {
      const age = ageMs(pod, o.now);
      if (age >= t.podPendingMinutes * MIN) {
        const scheduled = cond(pod, "PodScheduled");
        const why =
          scheduled?.status === "False"
            ? `${scheduled.reason ?? "Unschedulable"}${scheduled.message ? `: ${scheduled.message}` : ""}`
            : (containers(pod).find((c) => c.state?.waiting?.reason)?.state?.waiting?.reason ?? "not started");
        pending.push({
          object: pod,
          status: "warn",
          text: `${nsName(pod)} Pending for ${minutes(age)} (${why})`,
          raw: { ageMinutes: Math.floor(age / MIN), scheduled: scheduled ?? null },
        });
      }
    }

    for (const c of pod.status?.containerStatuses ?? []) {
      const n = o.restartsInWindow(pod, c.name);
      if (n !== undefined && n >= t.restartSpikeCount) {
        spikes.push({
          object: pod,
          status: "warn",
          text: `${nsName(pod)} ${c.name}: ${plural(n, "restart")} in ${t.restartSpikeMinutes}m`,
          raw: { container: c.name, restartsInWindow: n, restartCount: c.restartCount ?? 0 },
        });
      }
    }
  }

  const base = (id: string, label: string) => ({ id, label, observedAt });
  const running = (pods as PodObject[]).filter(live).length;
  return [
    summarise(
      base("pods-crashloop", "Crashing pods"),
      crash,
      "pod",
      o.link,
      `No crashing containers in ${plural(running, "pod")}`,
      "pods"
    ),
    summarise(base("pods-image", "Image pulls"), image, "pod", o.link, "No image pull errors", "pods"),
    summarise(
      base("pods-pending", "Pending pods"),
      pending,
      "pod",
      o.link,
      `No pod Pending longer than ${t.podPendingMinutes}m`,
      "pods"
    ),
    summarise(
      base("pods-restarts", "Restart spikes"),
      spikes,
      "pod",
      o.link,
      `No container restarted ${t.restartSpikeCount}+ times in ${t.restartSpikeMinutes}m`,
      "pods"
    ),
  ];
}

export function judgePvcs(
  pvcs: KubeObject[],
  volumes: Snapshot["volumes"],
  o: JudgeOptions,
  observedAt: string
): CheckResult[] {
  const t = o.thresholds;
  const binding: Offender[] = [];
  for (const pvc of pvcs as PvcObject[]) {
    const phase = pvc.status?.phase;
    if (phase === "Lost") {
      binding.push({
        object: pvc,
        status: "crit",
        text: `${nsName(pvc)} Lost: its volume ${pvc.spec?.volumeName ?? "?"} is gone`,
        raw: { phase, volumeName: pvc.spec?.volumeName ?? null },
      });
    } else if (phase === "Pending") {
      const age = ageMs(pvc, o.now);
      if (age >= t.pvcPendingMinutes * MIN) {
        binding.push({
          object: pvc,
          status: "warn",
          text: `${nsName(pvc)} Pending for ${minutes(age)} (storage class ${pvc.spec?.storageClassName ?? "default"})`,
          raw: { phase, ageMinutes: Math.floor(age / MIN), storageClassName: pvc.spec?.storageClassName ?? null },
        });
      }
    }
  }

  const bound = (pvcs as PvcObject[]).filter((p) => p.status?.phase === "Bound").length;
  const claims = summarise(
    { id: "pvcs", label: "Volume claims", observedAt },
    binding,
    "pvc",
    o.link,
    `${bound}/${plural(pvcs.length, "claim")} Bound`,
    "claims"
  );

  return [claims, judgeVolumeUsage(pvcs, volumes, o, observedAt)];
}

const gib = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GiB`;

function judgeVolumeUsage(
  pvcs: KubeObject[],
  volumes: Snapshot["volumes"],
  o: JudgeOptions,
  observedAt: string
): CheckResult {
  const base = { id: "pvc-usage", label: "Volume usage", observedAt };
  const t = o.thresholds;
  const { stats, errors } = volumes;
  if (!stats.length && errors.length) {
    return {
      ...base,
      status: "unknown",
      detail: `Kubelet volume stats unavailable: ${errors.join("; ")}`,
      raw: { errors },
    };
  }

  // A volume mounted on several nodes reports from each; one entry per claim.
  const byClaim = new Map<string, VolumeStat>();
  for (const s of stats) {
    const key = `${s.namespace}/${s.name}`;
    if (!byClaim.has(key) && s.capacityBytes > 0) byClaim.set(key, s);
  }
  const byKey = new Map(pvcs.map((p) => [nsName(p), p]));
  const pct = (s: VolumeStat) => Math.round((s.usedBytes / s.capacityBytes) * 1000) / 10;
  const offenders: Offender[] = [];
  let highest = 0;
  for (const [key, s] of byClaim) {
    const p = pct(s);
    highest = Math.max(highest, p);
    if (p < t.volumeWarnPercent) continue;
    const object: KubeObject = byKey.get(key) ?? { metadata: { name: s.name, namespace: s.namespace } };
    offenders.push({
      object,
      status: p >= t.volumeCritPercent ? "crit" : "warn",
      text: `${key} ${p}% full (${gib(s.usedBytes)} of ${gib(s.capacityBytes)})`,
      raw: { percent: p, usedBytes: s.usedBytes, capacityBytes: s.capacityBytes, node: s.node },
    });
  }
  offenders.sort((a, b) => (b.raw.percent as number) - (a.raw.percent as number));
  const partial = errors.length ? `; no stats from ${errors.join("; ")}` : "";
  const result = summarise(
    base,
    offenders,
    "pvc",
    o.link,
    byClaim.size
      ? `${plural(byClaim.size, "mounted volume")} below ${t.volumeWarnPercent}%, highest ${highest}%`
      : "No mounted volumes report usage",
    "volumes"
  );
  return {
    ...result,
    value: highest,
    detail: result.detail + partial,
    ...(errors.length ? { raw: { offenders: result.raw ?? [], errors } } : {}),
  };
}

export function judgeCertificates(
  certificates: KubeObject[] | "absent",
  o: JudgeOptions,
  observedAt: string
): CheckResult {
  const base = { id: "certificates", label: "Certificates", observedAt };
  if (certificates === "absent") {
    return { ...base, status: "absent", detail: "cert-manager is not installed" };
  }
  const t = o.thresholds;
  const offenders: Offender[] = [];
  let soonest: number | undefined;
  for (const cert of certificates as CertificateObject[]) {
    const ready = cond(cert, "Ready");
    const notAfter = Date.parse(cert.status?.notAfter ?? "");
    const daysLeft = Number.isNaN(notAfter) ? undefined : Math.floor((notAfter - o.now) / DAY);
    if (daysLeft !== undefined) soonest = soonest === undefined ? daysLeft : Math.min(soonest, daysLeft);
    const raw = {
      ready: ready ?? null,
      notAfter: cert.status?.notAfter ?? null,
      renewalTime: cert.status?.renewalTime ?? null,
      lastFailureTime: cert.status?.lastFailureTime ?? null,
      failedIssuanceAttempts: cert.status?.failedIssuanceAttempts ?? null,
      secretName: cert.spec?.secretName ?? null,
    };
    const failing = cert.status?.lastFailureTime ? `, last issuance failed ${cert.status.lastFailureTime}` : "";
    if (daysLeft !== undefined && daysLeft < 0) {
      offenders.push({
        object: cert,
        status: "crit",
        text: `${nsName(cert)} expired ${-daysLeft}d ago${failing}`,
        raw,
      });
    } else if (ready?.status !== "True") {
      const why = ready
        ? `${ready.reason ?? ready.status}${ready.message ? `: ${ready.message}` : ""}`
        : "no Ready condition";
      offenders.push({ object: cert, status: "crit", text: `${nsName(cert)} not Ready (${why})`, raw });
    } else if (daysLeft !== undefined && daysLeft <= t.certWarnDays) {
      offenders.push({
        object: cert,
        status: daysLeft <= t.certCritDays ? "crit" : "warn",
        text: `${nsName(cert)} expires in ${daysLeft}d${failing}`,
        raw,
      });
    } else if (failing) {
      offenders.push({ object: cert, status: "warn", text: `${nsName(cert)} renewal failing${failing}`, raw });
    }
  }
  const result = summarise(
    base,
    offenders,
    "certificate",
    o.link,
    certificates.length
      ? `${plural(certificates.length, "certificate")} Ready${soonest !== undefined ? `, next expiry in ${soonest}d` : ""}`
      : "No cert-manager Certificates",
    "certificates"
  );
  return { ...result, ...(soonest !== undefined ? { value: soonest } : {}) };
}

const CONTROL_PLANE = new Set(["kube-apiserver", "kube-controller-manager", "kube-scheduler", "etcd"]);

export function judgeSystem(pods: KubeObject[], o: JudgeOptions, observedAt: string): CheckResult[] {
  const system = (pods as PodObject[]).filter((p) => p.metadata.namespace === "kube-system" && live(p));
  const podReady = (p: PodObject) => cond(p, "Ready")?.status === "True";

  // kubeadm and RKE2 run these as static pods; k3s and managed clusters run
  // them outside any pod, so there is nothing to judge beyond the API check.
  const components = system.filter(
    (p) => p.metadata.labels?.tier === "control-plane" || CONTROL_PLANE.has(p.metadata.labels?.component ?? "")
  );
  const controlPlane: CheckResult = components.length
    ? summarise(
        { id: "control-plane", label: "Control plane", observedAt },
        components
          .filter((p) => !podReady(p))
          .map((p) => ({
            object: p,
            status: "crit",
            text: `${nsName(p)} not Ready${p.spec?.nodeName ? ` on ${p.spec.nodeName}` : ""}`,
            raw: { component: p.metadata.labels?.component ?? null, phase: p.status?.phase ?? null },
          })),
        "pod",
        o.link,
        `${plural(components.length, "control-plane pod")} Ready`,
        "pods"
      )
    : {
        id: "control-plane",
        label: "Control plane",
        status: "absent",
        detail: "Control-plane components do not run as pods in this cluster",
        observedAt,
      };

  const dnsPods = system.filter(
    (p) =>
      ["kube-dns", "coredns"].includes(p.metadata.labels?.["k8s-app"] ?? "") || p.metadata.name.startsWith("coredns-")
  );
  const dnsReady = dnsPods.filter(podReady).length;
  const dnsDown = dnsPods.filter((p) => !podReady(p));
  const dnsLink = o.link({ kind: "pod" });
  const dns: CheckResult = !dnsPods.length
    ? { id: "dns", label: "Cluster DNS", status: "absent", detail: "No CoreDNS pods in kube-system", observedAt }
    : {
        id: "dns",
        label: "Cluster DNS",
        status: dnsReady === 0 ? "crit" : dnsDown.length ? "warn" : "ok",
        value: dnsReady,
        detail: `${dnsReady}/${plural(dnsPods.length, "CoreDNS pod")} Ready${dnsDown.length ? `; not Ready: ${dnsDown.map((p) => p.metadata.name).join(", ")}` : ""}`,
        ...(dnsDown.length
          ? { raw: dnsDown.map((p) => ({ pod: nsName(p), conditions: p.status?.conditions ?? [] })) }
          : {}),
        ...(dnsDown.length && dnsLink ? { deepLink: dnsLink } : {}),
        observedAt,
      };
  return [controlPlane, dns];
}

const minorOf = (v: string | undefined) => {
  const m = /^v?(\d+)\.(\d+)/.exec(v ?? "");
  return m ? Number(m[2]) : undefined;
};

// Kubelets may trail the API server by up to three minor versions
// (Kubernetes 1.28+ skew policy) and may never lead it.
export function judgeVersion(
  version: K8sVersion | Error,
  nodes: KubeObject[],
  o: JudgeOptions,
  observedAt: string
): CheckResult {
  const base = { id: "version-skew", label: "Version skew", observedAt };
  if (version instanceof Error) {
    return {
      ...base,
      status: "unknown",
      detail: `API server version unavailable: ${version.message}`,
      raw: { error: version.message },
    };
  }
  const api = Number.parseInt(version.minor, 10);
  const offenders: Offender[] = [];
  const versions = new Set<string>();
  for (const node of nodes as NodeObject[]) {
    const kubelet = node.status?.nodeInfo?.kubeletVersion;
    if (kubelet) versions.add(kubelet);
    const minor = minorOf(kubelet);
    if (minor === undefined || Number.isNaN(api)) continue;
    if (minor > api) {
      offenders.push({
        object: node,
        status: "crit",
        text: `${node.metadata.name} kubelet ${kubelet} is newer than the API server ${version.gitVersion}`,
        raw: { kubelet, apiServer: version.gitVersion },
      });
    } else if (api - minor > 3) {
      offenders.push({
        object: node,
        status: "warn",
        text: `${node.metadata.name} kubelet ${kubelet} is ${api - minor} minor versions behind ${version.gitVersion}`,
        raw: { kubelet, apiServer: version.gitVersion },
      });
    }
  }
  const result = summarise(
    base,
    offenders,
    "node",
    o.link,
    `API server ${version.gitVersion}; kubelets ${[...versions].toSorted().join(", ") || "unknown"}`,
    "nodes"
  );
  return { ...result, value: version.gitVersion };
}

export function judgeApiCertificate(
  info: K8sServerInfo | Error | undefined,
  o: JudgeOptions,
  observedAt: string
): CheckResult {
  const base = { id: "api-certificate", label: "API server certificate", observedAt };
  if (info instanceof Error) {
    return {
      ...base,
      status: "unknown",
      detail: `API server certificate unreadable: ${info.message}`,
      raw: { error: info.message },
    };
  }
  const notAfter = Date.parse(info?.certificate?.notAfter ?? "");
  if (!info?.certificate || Number.isNaN(notAfter)) {
    return {
      ...base,
      status: "absent",
      detail: info ? `No TLS certificate read from ${info.url}` : "API server certificate not available",
    };
  }
  const t = o.thresholds;
  const days = Math.floor((notAfter - o.now) / DAY);
  const cert = info.certificate;
  const when = days < 0 ? `expired ${-days}d ago` : `expires in ${days}d`;
  const status: Status = days < t.apiCertCritDays ? "crit" : days < t.apiCertWarnDays ? "warn" : "ok";
  return {
    ...base,
    status,
    value: days,
    detail: `${info.host} certificate ${when} (notAfter ${cert.notAfter}, issuer ${cert.issuer})`,
    ...(status === "ok" ? {} : { raw: { url: info.url, ...cert } }),
  };
}

export function judge(snapshot: Snapshot, o: JudgeOptions): CheckResult[] {
  const observedAt = new Date(o.now).toISOString();
  return [
    ...judgeNodes(snapshot.nodes, o, observedAt),
    ...judgePods(snapshot.pods, o, observedAt),
    ...judgePvcs(snapshot.pvcs, snapshot.volumes, o, observedAt),
    judgeCertificates(snapshot.certificates, o, observedAt),
    ...judgeSystem(snapshot.pods, o, observedAt),
    judgeVersion(snapshot.version, snapshot.nodes, o, observedAt),
    judgeApiCertificate(snapshot.serverInfo, o, observedAt),
  ];
}

import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { CheckResult, HealthProvider } from "../../../src/contracts/health.js";
import { RESOURCES, type K8sServerInfo, type K8sVersion, type KubeObject } from "../../../src/contracts/k8s.js";
import { createMockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s, type FakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { DAY, MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import mod from "../../../src/modules/cluster/index.js";
import { judgePods } from "../../../src/modules/cluster/judge.js";
import { createLinker } from "../../../src/modules/cluster/links.js";
import { clusterHealthProvider } from "../../../src/modules/cluster/provider.js";
import { DEFAULT_THRESHOLDS, type Thresholds } from "../../../src/modules/cluster/settings.js";
import { createK8sService } from "../../../src/modules/k8s/api.js";
import { loadFixtureSet, scenarios, startFakeApi } from "../../support/index.js";

const fixtures = loadFixtureSet("synthetic");
const MIN = 60_000;
const RANCHER = "https://rancher.example.test/dashboard/c/local/explorer";

const summaryPath = (node: string) => `/api/v1/nodes/${node}/proxy/stats/summary`;

interface Setup {
  absentGroups?: string[];
  version?: K8sVersion;
  serverInfo?: K8sServerInfo;
  raw?: Record<string, unknown> | null;
  edit?: (k8s: FakeK8s) => void;
  thresholds?: Partial<Thresholds>;
  urls?: { rancher?: string; headlamp?: string };
}

function setup(options: Setup = {}) {
  const raw =
    options.raw === null
      ? {}
      : (options.raw ?? Object.fromEntries(Object.entries(fixtures.kubelet).map(([n, s]) => [summaryPath(n), s])));
  const k8s = createFakeK8s({
    objects: structuredClone(fixtures.lists),
    raw,
    ...(options.absentGroups ? { absentGroups: options.absentGroups } : {}),
    ...(options.version ? { version: options.version } : {}),
    ...(options.serverInfo ? { serverInfo: options.serverInfo } : {}),
  });
  options.edit?.(k8s);
  let now = MOCK_NOW;
  const provider = clusterHealthProvider({
    k8s: () => k8s,
    thresholds: () => ({ ...DEFAULT_THRESHOLDS, ...options.thresholds }),
    link: createLinker(() => ({ rancher: options.urls?.rancher ?? "", headlamp: options.urls?.headlamp ?? "" })),
    now: () => now,
  });
  return {
    k8s,
    provider,
    advance: (ms: number) => void (now += ms),
    collect: async () => byId(await provider.collect()),
  };
}

function byId(results: CheckResult[]): Record<string, CheckResult> {
  return Object.fromEntries(results.map((r) => [r.id, r]));
}

const find =
  (k8s: FakeK8s, ref = RESOURCES.pods) =>
  async (name: string) => {
    const items = (await k8s.list(ref)) as KubeObject[];
    const obj = items.find((o) => o.metadata.name === name);
    assert.ok(obj, `${name} in fixtures`);
    return obj;
  };

// Strips every failure scenario out of the synthetic set.
function healthy(k8s: FakeK8s) {
  const s = scenarios.pods;
  for (const pod of [s.crashloop, s.pending, s.imagePull]) k8s.remove(RESOURCES.pods, pod.name, pod.namespace);
  k8s.remove(RESOURCES.nodes, scenarios.nodes.notReady);
  k8s.remove(RESOURCES.pvcs, scenarios.pvcs.pending.name, scenarios.pvcs.pending.namespace);
  k8s.remove(RESOURCES.certificates, scenarios.certificates.expiring, "default");
  k8s.remove(RESOURCES.certificates, scenarios.certificates.notReady, "default");
}

test("every check on the synthetic cluster", async () => {
  const r = await setup({ urls: { rancher: RANCHER } }).collect();
  assert.deepEqual(Object.keys(r).toSorted(), [
    "api-certificate",
    "certificates",
    "control-plane",
    "dns",
    "node-pressure",
    "nodes",
    "pods-crashloop",
    "pods-image",
    "pods-pending",
    "pods-restarts",
    "pvc-usage",
    "pvcs",
    "version-skew",
  ]);
  for (const result of Object.values(r)) {
    assert.ok(result.detail.length > 0, `${result.id} has a detail`);
    assert.equal(result.observedAt, new Date(MOCK_NOW).toISOString());
    if (result.status === "warn" || result.status === "crit") assert.ok(result.raw, `${result.id} carries raw`);
  }
});

test("a NotReady node is critical", async () => {
  const { nodes } = await setup({ urls: { rancher: RANCHER } }).collect();
  assert.equal(nodes!.status, "crit");
  assert.equal(nodes!.value, 1);
  assert.match(nodes!.detail, new RegExp(`^${scenarios.nodes.notReady} NotReady \\(NodeStatusUnknown`));
  assert.match(nodes!.detail, /2\/3 nodes Ready/);
  assert.equal(nodes!.deepLink, `${RANCHER}/node/${scenarios.nodes.notReady}`);
  assert.deepEqual(nodes!.object, { kind: "Node", name: scenarios.nodes.notReady });
});

test("pressure on a Ready node warns; a NotReady node's stale conditions are ignored", async () => {
  const { "node-pressure": p } = await setup().collect();
  assert.equal(p!.status, "warn");
  assert.equal(p!.value, 1);
  assert.match(p!.detail, new RegExp(`^${scenarios.nodes.pressure}: MemoryPressure`));
});

test("NetworkUnavailable is critical", async () => {
  const { "node-pressure": p } = await setup({
    edit: (k8s) => {
      healthy(k8s);
      const node = structuredClone(fixtures.lists.find((l) => l.ref.plural === "nodes")!.items[0]!);
      (node.status as { conditions: object[] }).conditions.push({ type: "NetworkUnavailable", status: "True" });
      k8s.upsert(RESOURCES.nodes, node);
    },
  }).collect();
  assert.equal(p!.status, "crit");
});

test("CrashLoopBackOff is critical, with the last exit", async () => {
  const s = scenarios.pods.crashloop;
  const { "pods-crashloop": c } = await setup({ urls: { rancher: RANCHER } }).collect();
  assert.equal(c!.status, "crit");
  assert.equal(c!.value, 1);
  assert.match(
    c!.detail,
    new RegExp(`^${s.namespace}/${s.name} report: CrashLoopBackOff, 27 restarts; last exit 1 \\(Error\\)`)
  );
  assert.equal(c!.deepLink, `${RANCHER}/pod/${s.namespace}/${s.name}`);
  assert.deepEqual(c!.object, { kind: "Pod", namespace: s.namespace, name: s.name });
});

test("an image pull error is critical", async () => {
  const s = scenarios.pods.imagePull;
  const { "pods-image": c } = await setup().collect();
  assert.equal(c!.status, "crit");
  assert.match(c!.detail, new RegExp(`^${s.namespace}/${s.name} legacy: ImagePullBackOff`));
});

test("a pod Pending past the threshold warns with the scheduler's reason", async () => {
  const s = scenarios.pods.pending;
  const { "pods-pending": p } = await setup().collect();
  assert.equal(p!.status, "warn");
  assert.match(p!.detail, new RegExp(`^${s.namespace}/${s.name} Pending for 47m \\(Unschedulable: 0/3 nodes`));
  // The image-pull pod is also Pending but is reported once, as an image error.
  assert.equal(p!.value, 1);

  const later = await setup({ thresholds: { podPendingMinutes: 60 } }).collect();
  assert.equal(later["pods-pending"]!.status, "ok");
});

test("a restart spike needs a baseline, then warns", async () => {
  const s = scenarios.pods.healthy;
  const env = setup();
  const pod = await find(env.k8s)(s.name);
  assert.equal((await env.collect())["pods-restarts"]!.status, "ok");

  env.advance(10 * MIN);
  const bumped = structuredClone(pod);
  (bumped.status as { containerStatuses: Array<{ restartCount: number }> }).containerStatuses[0]!.restartCount = 6;
  env.k8s.upsert(RESOURCES.pods, bumped);
  const spike = (await env.collect())["pods-restarts"]!;
  assert.equal(spike.status, "warn");
  assert.match(spike.detail, new RegExp(`^${s.namespace}/${s.name} web: 6 restarts in 60m`));

  // Once the window has passed with no new restarts, it clears.
  env.advance(61 * MIN);
  await env.collect();
  env.advance(MIN);
  assert.equal((await env.collect())["pods-restarts"]!.status, "ok");
});

test("a pending PVC warns and a Lost one is critical", async () => {
  const p = scenarios.pvcs.pending;
  const first = (await setup().collect()).pvcs!;
  assert.equal(first.status, "warn");
  assert.match(first.detail, new RegExp(`^${p.namespace}/${p.name} Pending for \\d+h \\(storage class longhorn\\)`));

  const lost = await setup({
    edit: (k8s) => {
      const pvc = structuredClone(fixtures.lists.find((l) => l.ref.plural === "persistentvolumeclaims")!.items[0]!);
      (pvc.status as { phase: string }).phase = "Lost";
      k8s.upsert(RESOURCES.pvcs, pvc);
    },
  }).collect();
  assert.equal(lost.pvcs!.status, "crit");
  assert.equal(lost.pvcs!.value, 2);
  assert.match(lost.pvcs!.detail, / Lost: its volume .* is gone \(\+1 more claims\)$/);
});

test("volume usage comes from kubelet stats", async () => {
  const s = scenarios.pvcs.stale;
  const { "pvc-usage": u } = await setup({ urls: { headlamp: "https://headlamp.example.test/c/main" } }).collect();
  assert.equal(u!.status, "crit");
  assert.equal(u!.value, 93);
  assert.match(u!.detail, new RegExp(`^${s.namespace}/${s.name} 93% full \\(93.0 GiB of 100.0 GiB\\)`));
  assert.equal(u!.deepLink, `https://headlamp.example.test/c/main/persistentvolumeclaims/${s.namespace}/${s.name}`);
  assert.deepEqual(u!.object, { kind: "PersistentVolumeClaim", namespace: s.namespace, name: s.name });

  const relaxed = await setup({ thresholds: { volumeWarnPercent: 90, volumeCritPercent: 95 } }).collect();
  assert.equal(relaxed["pvc-usage"]!.status, "warn");
  const ok = await setup({ thresholds: { volumeWarnPercent: 95, volumeCritPercent: 99 } }).collect();
  assert.equal(ok["pvc-usage"]!.status, "ok");
  assert.match(ok["pvc-usage"]!.detail, /^2 mounted volumes below 95%, highest 93%$/);
});

test("kubelet stats that can't be read are unknown, or noted when partial", async () => {
  const none = await setup({ raw: null }).collect();
  assert.equal(none["pvc-usage"]!.status, "unknown");
  assert.match(none["pvc-usage"]!.detail, /^Kubelet volume stats unavailable: /);

  const partial = await setup({
    raw: { [summaryPath(scenarios.nodes.pressure)]: fixtures.kubelet[scenarios.nodes.pressure] },
  }).collect();
  assert.equal(partial["pvc-usage"]!.status, "crit");
  assert.match(partial["pvc-usage"]!.detail, /; no stats from cp-1: /);
});

test("certificates: expiring soon and not Ready are critical, the healthy one passes", async () => {
  const c = scenarios.certificates;
  const { certificates: r } = await setup({ urls: { rancher: RANCHER } }).collect();
  assert.equal(r!.status, "crit");
  assert.equal(r!.value, 5);
  const raw = r!.raw as Array<{ object: string; status: string }>;
  assert.deepEqual(raw.map((o) => o.object).toSorted(), [`default/${c.expiring}`, `default/${c.notReady}`]);
  assert.match(r!.detail, /\(\+1 more certificates\)$/);
  // Several offenders: the list page, and the worst one as the object.
  assert.equal(r!.deepLink, `${RANCHER}/cert-manager.io.certificate`);
  assert.equal(r!.object?.kind, "Certificate");
});

test("certificate thresholds, failed renewals and expiry", async () => {
  const c = scenarios.certificates;
  const only = (edit: (cert: KubeObject) => void, thresholds: Partial<Thresholds> = {}) =>
    setup({
      thresholds,
      edit: (k8s) => {
        healthy(k8s);
        const cert = structuredClone(
          fixtures.lists.find((l) => l.ref.plural === "certificates")!.items.find((o) => o.metadata.name === c.healthy)!
        );
        edit(cert);
        k8s.upsert(RESOURCES.certificates, cert);
      },
    })
      .collect()
      .then((r) => r.certificates!);

  const fine = await only(() => {});
  assert.equal(fine.status, "ok");
  assert.match(fine.detail, /^1 certificate Ready, next expiry in 61d$/);

  assert.equal((await only(() => {}, { certWarnDays: 70, certCritDays: 7 })).status, "warn");

  const failing = await only((cert) => {
    certStatus(cert).lastFailureTime = new Date(MOCK_NOW - 3_600_000).toISOString();
    certStatus(cert).failedIssuanceAttempts = 2;
  });
  assert.equal(failing.status, "warn");
  assert.match(failing.detail, /renewal failing, last issuance failed/);

  const expired = await only((cert) => {
    certStatus(cert).notAfter = new Date(MOCK_NOW - 2 * DAY).toISOString();
  });
  assert.equal(expired.status, "crit");
  assert.match(expired.detail, /expired 2d ago/);
});

test("cert-manager not installed is absent, not an error", async () => {
  const { certificates } = await setup({ absentGroups: ["cert-manager.io"] }).collect();
  assert.equal(certificates!.status, "absent");
});

const certStatus = (cert: KubeObject) => cert.status as Record<string, unknown>;

const staticPod = (component: string, ready: boolean): KubeObject => ({
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: `${component}-cp-1`, namespace: "kube-system", labels: { component, tier: "control-plane" } },
  spec: { nodeName: "cp-1" },
  status: { phase: "Running", conditions: [{ type: "Ready", status: ready ? "True" : "False" }] },
});

test("control plane: absent without static pods, critical when one is not Ready", async () => {
  const absent = await setup().collect();
  assert.equal(absent["control-plane"]!.status, "absent");

  const r = await setup({
    edit: (k8s) => {
      k8s.upsert(RESOURCES.pods, staticPod("kube-apiserver", true));
      k8s.upsert(RESOURCES.pods, staticPod("kube-scheduler", false));
    },
  }).collect();
  assert.equal(r["control-plane"]!.status, "crit");
  assert.match(r["control-plane"]!.detail, /^kube-system\/kube-scheduler-cp-1 not Ready on cp-1/);
});

test("cluster DNS: ok when CoreDNS is Ready, critical when none is", async () => {
  assert.equal((await setup().collect()).dns!.status, "ok");
  const down = await setup({
    edit: (k8s) => {
      const pod = structuredClone(
        fixtures.lists.find((l) => l.ref.plural === "pods")!.items.find((o) => o.metadata.name.startsWith("coredns-"))!
      );
      for (const c of (pod.status as { conditions: Array<{ type: string; status: string }> }).conditions) {
        if (c.type === "Ready") c.status = "False";
      }
      k8s.upsert(RESOURCES.pods, pod);
    },
  }).collect();
  assert.equal(down.dns!.status, "crit");
});

test("version skew: kubelets newer than the API server are critical, far behind warns", async () => {
  const ok = await setup().collect();
  assert.equal(ok["version-skew"]!.status, "ok");
  assert.equal(ok["version-skew"]!.value, "v1.31.4+k3s1");

  const older = await setup({ version: { major: "1", minor: "30", gitVersion: "v1.30.9" } }).collect();
  assert.equal(older["version-skew"]!.status, "crit");
  assert.equal(older["version-skew"]!.value, "v1.30.9");

  const newer = await setup({ version: { major: "1", minor: "35+", gitVersion: "v1.35.0" } }).collect();
  assert.equal(newer["version-skew"]!.status, "warn");
  assert.match(newer["version-skew"]!.detail, /4 minor versions behind v1\.35\.0/);
});

const info = (days: number): K8sServerInfo => ({
  url: "https://10.0.0.10:6443",
  host: "10.0.0.10",
  certificate: { subject: "k3s", issuer: "k3s-server-ca", notAfter: new Date(MOCK_NOW + days * DAY).toISOString() },
});

test("API server certificate: ok, warn under 30 days, critical under 7, expired", async () => {
  const check = async (serverInfo?: K8sServerInfo) =>
    (await setup(serverInfo ? { serverInfo } : {}).collect())["api-certificate"]!;

  const fine = await check();
  assert.equal(fine.status, "ok");
  assert.equal(fine.value, 300);
  assert.match(fine.detail, /^10\.0\.0\.10 certificate expires in 300d \(notAfter 20\d\d-.*, issuer k3s-server-ca\)$/);

  const soon = await check(info(20));
  assert.equal(soon.status, "warn");
  assert.match(soon.detail, new RegExp(`expires in 20d \\(notAfter ${info(20).certificate!.notAfter}`));
  assert.ok(soon.raw);

  assert.equal((await check(info(3))).status, "crit");
  const expired = await check(info(-2));
  assert.equal(expired.status, "crit");
  assert.match(expired.detail, /expired 2d ago/);

  const relaxed = await setup({ serverInfo: info(20), thresholds: { apiCertWarnDays: 10 } }).collect();
  assert.equal(relaxed["api-certificate"]!.status, "ok");
});

test("API server certificate: skipped without a certificate or serverInfo, unknown when it fails", async () => {
  const plain = await setup({ serverInfo: { url: "http://10.0.0.10:8080", host: "10.0.0.10" } }).collect();
  assert.equal(plain["api-certificate"]!.status, "absent");

  const unsupported = await setup({
    edit: (k8s) => {
      delete (k8s as { serverInfo?: unknown }).serverInfo;
    },
  }).collect();
  assert.equal(unsupported["api-certificate"]!.status, "absent");

  const failing = await setup({
    edit: (k8s) => {
      k8s.serverInfo = () => Promise.reject(new Error("tls handshake failed"));
    },
  }).collect();
  assert.equal(failing["api-certificate"]!.status, "unknown");
  assert.match(failing["api-certificate"]!.detail, /tls handshake failed/);
});

test("a cluster with every failure scenario removed is all OK", async () => {
  const r = await setup({ urls: { rancher: RANCHER }, edit: healthy }).collect();
  // worker-1 still carries MemoryPressure and media-library is 93% full in the fixtures.
  const expected = { "node-pressure": "warn", "pvc-usage": "crit", "control-plane": "absent" } as Record<
    string,
    string
  >;
  for (const [id, result] of Object.entries(r)) {
    assert.equal(result.status, expected[id] ?? "ok", `${id}: ${result.detail}`);
    if (result.status === "ok") {
      assert.equal(result.deepLink, undefined, `${id} links only on failure`);
      assert.equal(result.object, undefined, `${id} names an object only on failure`);
    }
  }
});

test("no Kubernetes service: one unknown result saying why", async () => {
  const provider = clusterHealthProvider({
    k8s: () => {
      throw new Error('service "k8s" has not been provided');
    },
    thresholds: () => DEFAULT_THRESHOLDS,
    link: () => undefined,
    now: () => MOCK_NOW,
  });
  const [only, ...rest] = await provider.collect();
  assert.equal(rest.length, 0);
  assert.equal(only!.status, "unknown");
  assert.match(only!.detail, /has not been provided/);
});

test("the module registers a cluster provider and reads its settings fresh", async () => {
  const k8s = createFakeK8s({ objects: structuredClone(fixtures.lists) });
  const mock = createMockContext("cluster", {
    migrations: mod.migrations ?? [],
    services: { k8s },
    settings: { "cluster.rancherUrl": `${RANCHER}/`, "cluster.podPendingMinutes": "30" },
  });
  try {
    await mod.register(mock.ctx);
    const providers: HealthProvider[] = [];
    mock.ctx.health.subscribe((p) => providers.push(p));
    assert.deepEqual(
      providers.map((p) => [p.id, p.category]),
      [["cluster", "cluster"]]
    );
    const r = byId(await providers[0]!.collect());
    assert.equal(r.nodes!.status, "crit");
    // The trailing slash is trimmed when the setting is parsed.
    assert.equal(r.nodes!.deepLink, `${RANCHER}/node/${scenarios.nodes.notReady}`);
  } finally {
    await mock.close();
  }
});

test("end to end through the fake API server and the real Kubernetes service", async () => {
  const api = await startFakeApi({ fixtures });
  try {
    const conn = { source: "kubeconfig" as const, server: api.url, context: "fake", kubeConfig: api.kubeConfig() };
    const k8s = createK8sService({ connection: () => conn });
    after(() => k8s.close());
    const provider = clusterHealthProvider({
      k8s: () => k8s,
      thresholds: () => DEFAULT_THRESHOLDS,
      link: () => undefined,
      now: () => MOCK_NOW,
    });
    const r = byId(await provider.collect());
    assert.equal(r.nodes!.status, "crit");
    assert.equal(r["pods-crashloop"]!.status, "crit");
    assert.equal(r["pvc-usage"]!.status, "crit", r["pvc-usage"]!.detail);
    assert.equal(r.certificates!.status, "crit");
    // A second collect reads the informer caches.
    const again = byId(await provider.collect());
    assert.equal(again.nodes!.detail, r.nodes!.detail);
  } finally {
    await api.close();
  }
});

const crashingPod = (restarts: number, ageMs: number, job = false): KubeObject => ({
  apiVersion: "v1",
  kind: "Pod",
  metadata: {
    name: job ? "helm-install-traefik-949mz" : "web-1",
    namespace: "kube-system",
    creationTimestamp: new Date(MOCK_NOW - ageMs).toISOString(),
    ...(job
      ? { ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name: "helm-install-traefik", uid: "u" }] }
      : {}),
  },
  status: {
    phase: "Running",
    containerStatuses: [
      {
        name: "helm",
        restartCount: restarts,
        state: { waiting: { reason: "CrashLoopBackOff" } },
        lastState: { terminated: { exitCode: 1, reason: "Error" } },
      },
    ],
  },
});

const crashResult = (pod: KubeObject) =>
  judgePods(
    [pod],
    { now: MOCK_NOW, thresholds: DEFAULT_THRESHOLDS, link: () => undefined, restartsInWindow: () => undefined },
    "now"
  ).find((r) => r.id === "pods-crashloop")!;

test("a Job's pod retrying is quiet, then a warning, then critical at the backoff limit", () => {
  assert.equal(crashResult(crashingPod(1, 60_000, true)).status, "ok");
  assert.equal(crashResult(crashingPod(2, 60 * 60_000, true)).status, "ok");
  const retrying = crashResult(crashingPod(4, 60 * 60_000, true));
  assert.equal(retrying.status, "warn");
  assert.match(retrying.detail, /its Job is still retrying$/);
  assert.equal(crashResult(crashingPod(6, 60 * 60_000, true)).status, "crit");
});

test("a brand-new pod's first crashes warn; older or repeated ones are critical", () => {
  assert.equal(crashResult(crashingPod(1, 60_000)).status, "warn");
  assert.equal(crashResult(crashingPod(3, 60_000)).status, "crit");
  assert.equal(crashResult(crashingPod(1, 10 * 60_000)).status, "crit");
});

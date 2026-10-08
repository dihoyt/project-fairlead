import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type {
  CatalogAppView,
  CatalogBundleView,
  CatalogService,
  DiscoveryReport,
} from "../../../src/contracts/catalog.js";
import { RESOURCES, type K8sApi, type KubeObject, type ResourceRef } from "../../../src/contracts/k8s.js";
import { mockCatalog } from "../../../src/contracts/mocks/catalog.js";
import { createMockContext, mockViewer, type MockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s, OWNER_LABEL, type FakeK8sOptions } from "../../../src/contracts/mocks/k8s.js";
import { deployedLabel } from "../../../src/contracts/deployed.js";
import { pickVersion } from "../../../src/contracts/kubeversion.js";
import { createMockDeployService } from "../../../src/contracts/mocks/deploy.js";
import { product } from "../../../src/product.js";
import mod from "../../../src/modules/catalog/index.js";
import { baseDomain, discover } from "../../../src/modules/catalog/discover.js";
import { bundleView, bundles } from "../../../src/modules/catalog/bundles.js";
import { catalog } from "../../../src/modules/catalog/entries.js";
import { nodeDisks } from "../../../src/modules/catalog/disks.js";
import { ntfyManifest } from "../../../src/modules/catalog/manifests/ntfy.js";
import { createCatalogService } from "../../../src/modules/catalog/service.js";
import { chartName, parseImage, signatures } from "../../../src/modules/catalog/signatures.js";
import { loadFixtureSet } from "../../support/index.js";
import { listen } from "../../runtime/helpers.js";

// --- builders ---------------------------------------------------------------

function workload(
  namespace: string,
  name: string,
  options: { labels?: Record<string, string>; podLabels?: Record<string, string>; image?: string } = {}
): KubeObject {
  return {
    metadata: { name, namespace, labels: options.labels ?? {} },
    spec: {
      template: {
        metadata: { labels: options.podLabels ?? { app: name } },
        spec: { containers: [{ name, image: options.image ?? "example/unrelated:1.0" }] },
      },
    },
  };
}

function ingress(
  namespace: string,
  name: string,
  rules: Array<{ host: string; service: string }>,
  tlsHosts: string[] = []
): KubeObject {
  return {
    metadata: { name, namespace },
    spec: {
      ...(tlsHosts.length ? { tls: [{ hosts: tlsHosts, secretName: `${name}-tls` }] } : {}),
      rules: rules.map((r) => ({
        host: r.host,
        http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: r.service } } }] },
      })),
    },
  };
}

const svc = (namespace: string, name: string, selector: Record<string, string>): KubeObject => ({
  metadata: { name, namespace },
  spec: { selector },
});

const named = (name: string, annotations: Record<string, string> = {}): KubeObject => ({
  metadata: { name, annotations },
});

const issuer = (name: string, readyStatus?: "True" | "False"): KubeObject => ({
  metadata: { name },
  ...(readyStatus ? { status: { conditions: [{ type: "Ready", status: readyStatus }] } } : {}),
});

const DEFAULT_SC = { "storageclass.kubernetes.io/is-default-class": "true" };
const DEFAULT_IC = { "ingressclass.kubernetes.io/is-default-class": "true" };

// A small healthy cluster: Grafana behind TLS, Headlamp behind an auth
// proxy, every basic in place.
function healthyCluster(): NonNullable<FakeK8sOptions["objects"]> {
  return [
    {
      ref: RESOURCES.deployments,
      items: [
        workload("monitoring", "grafana", {
          labels: {
            "app.kubernetes.io/name": "grafana",
            "app.kubernetes.io/instance": "grafana",
            "app.kubernetes.io/managed-by": "Helm",
            "app.kubernetes.io/version": "12.2.0",
          },
          podLabels: { "app.kubernetes.io/name": "grafana", "app.kubernetes.io/instance": "grafana" },
          image: "docker.io/grafana/grafana:12.2.0",
        }),
        workload("headlamp", "headlamp", { image: "ghcr.io/headlamp-k8s/headlamp:v0.45.0" }),
        workload("headlamp", "oauth2-proxy", { image: "quay.io/oauth2-proxy/oauth2-proxy:latest" }),
        workload("media", "jellyfin", { image: "jellyfin/jellyfin:10.10.0" }),
      ],
    },
    {
      ref: RESOURCES.ingresses,
      items: [
        ingress(
          "monitoring",
          "grafana",
          [{ host: "grafana.home.example.com", service: "grafana" }],
          ["grafana.home.example.com"]
        ),
        ingress("headlamp", "headlamp", [{ host: "headlamp.home.example.com", service: "oauth2-proxy" }]),
        ingress("media", "jellyfin", [{ host: "jellyfin.home.example.com", service: "jellyfin" }]),
        ingress("media", "wild", [{ host: "*.example.com", service: "jellyfin" }]),
        ingress("other", "solo", [{ host: "solo.other.example.net", service: "solo" }]),
      ],
    },
    {
      ref: RESOURCES.services,
      items: [
        svc("monitoring", "grafana", {
          "app.kubernetes.io/name": "grafana",
          "app.kubernetes.io/instance": "grafana",
        }),
        svc("headlamp", "oauth2-proxy", { app: "oauth2-proxy" }),
        svc("media", "jellyfin", { app: "jellyfin" }),
      ],
    },
    { ref: RESOURCES.storageClasses, items: [named("longhorn", DEFAULT_SC), named("local-path")] },
    { ref: RESOURCES.ingressClasses, items: [named("traefik", DEFAULT_IC)] },
    {
      ref: RESOURCES.clusterIssuers,
      items: [issuer("letsencrypt-staging", "True"), issuer("letsencrypt-prod", "True")],
    },
    { ref: RESOURCES.nodeMetrics, items: [named("node-1")] },
  ];
}

const app = (report: DiscoveryReport, id: string) => report.apps.find((a) => a.appId === id)!;
const basic = (report: DiscoveryReport, id: string) => report.basics.find((b) => b.id === id)!;

// A K8sApi whose list throws for the given resources, as a 403 would.
function failing(k8s: K8sApi, refs: ResourceRef[]): K8sApi {
  return {
    ...k8s,
    list: async (ref, options) => {
      if (refs.includes(ref)) throw new Error(`forbidden: cannot list ${ref.plural}`);
      return k8s.list(ref, options);
    },
  };
}

const run = (objects: NonNullable<FakeK8sOptions["objects"]>, absentGroups: string[] = []) =>
  discover(createFakeK8s({ objects, absentGroups }), catalog);

const backupTarget = (url: string): KubeObject => ({
  metadata: { name: "default", namespace: "longhorn-system" },
  spec: { backupTargetURL: url },
});

function counting() {
  const k8s = createFakeK8s();
  let lists = 0;
  const counted: K8sApi = {
    ...k8s,
    list: async (ref, options) => {
      lists++;
      return k8s.list(ref, options);
    },
  };
  return { k8s: counted, lists: () => lists };
}

// --- the catalog ------------------------------------------------------------

describe("catalog entries", () => {
  test("covers the same apps as the contract's mock catalog, ids unique", () => {
    assert.deepEqual(catalog.map((e) => e.id).toSorted(), mockCatalog.map((e) => e.id).toSorted());
    assert.equal(new Set(catalog.map((e) => e.id)).size, catalog.length);
  });

  test("every version is a real pin, and requires name other entries", () => {
    for (const entry of catalog) {
      if (entry.install.kind !== "patch") {
        assert.match(entry.install.version, /^v?\d+\.\d+\.\d+$/, entry.id);
      }
      if (entry.install.kind === "helm") assert.match(entry.install.repo, /^(https|oci):\/\//, entry.id);
      for (const id of entry.requires)
        assert.ok(
          catalog.some((e) => e.id === id),
          `${entry.id} requires ${id}`
        );
    }
  });

  test("a manifest install has exactly one of url and bundled; ntfy's carries no Ingress", () => {
    for (const entry of catalog) {
      if (entry.install.kind !== "manifest") continue;
      assert.equal(Number(Boolean(entry.install.url)) + Number(Boolean(entry.install.bundled)), 1, entry.id);
    }
    const ntfy = catalog.find((e) => e.id === "ntfy")!.install;
    assert.equal(ntfy.kind, "manifest");
    const yaml = ntfy.kind === "manifest" ? (ntfy.bundled ?? "") : "";
    assert.match(yaml, /kind: Service\nmetadata:\n  name: ntfy\n  namespace: ntfy/);
    assert.match(yaml, /image: docker\.io\/binwiederhier\/ntfy:v\d+\.\d+\.\d+/);
    assert.doesNotMatch(yaml, /kind: Ingress/);
  });

  test("apps that fill a link or take a host expose a UI; inputs are unique per app", () => {
    for (const entry of catalog) {
      if (entry.linkKey) assert.ok(entry.exposesUi, entry.id);
      if (entry.inputs.some((i) => i.key === "host")) assert.ok(entry.exposesUi, entry.id);
      assert.equal(new Set(entry.inputs.map((i) => i.key)).size, entry.inputs.length, entry.id);
      assert.ok(entry.summary.endsWith("."), entry.id);
    }
  });

  test("every app installs on a k3s 1.31 cluster; Longhorn falls back to the 1.12 line there", () => {
    for (const entry of catalog) {
      if (entry.install.kind === "patch") continue;
      for (const fallback of entry.install.kind === "helm" ? (entry.install.fallbacks ?? []) : []) {
        assert.match(fallback.version, /^v?\d+\.\d+\.\d+$/, entry.id);
      }
      const picked = pickVersion(entry.install, "v1.31.4+k3s1");
      assert.ok(picked.ok, `${entry.id}: ${picked.ok ? "" : picked.reason}`);
    }
    const longhorn = catalog.find((e) => e.id === "longhorn")!.install;
    assert.deepEqual(pickVersion(longhorn, "v1.31.4+k3s1"), {
      ok: true,
      version: "1.12.1",
      kubeVersion: ">=1.25.0-0",
      fellBack: true,
    });
    assert.equal((pickVersion(longhorn, "v1.34.2") as { version: string }).version, "1.13.0");
  });

  test("every installable app has a disk footprint; volumes match its storage", () => {
    const GiB = 1024 ** 3;
    for (const entry of catalog) {
      if (entry.install.kind === "patch") {
        assert.equal(entry.disk, undefined, entry.id);
        continue;
      }
      assert.ok(entry.disk && entry.disk.imageBytes > 0, entry.id);
      assert.equal(entry.disk.volumeBytes > 0, entry.storage !== undefined, entry.id);
    }
    const gitea = catalog.find((e) => e.id === "gitea")!;
    assert.equal(gitea.disk?.volumeBytes, 5 * GiB);
    assert.equal(catalog.find((e) => e.id === "ntfy")!.disk?.volumeBytes, GiB / 2);
    assert.match(ntfyManifest, /storage: 512Mi/);
  });

  test("every installable app has a detection signature", () => {
    for (const entry of catalog) {
      if (entry.install.kind === "patch") continue;
      assert.ok(signatures[entry.id], entry.id);
    }
  });

  test("image and chart labels parse without registry, tag or version", () => {
    assert.deepEqual(parseImage("docker.io/library/traefik:v3.5@sha256:abc"), { repo: "traefik", tag: "v3.5" });
    assert.deepEqual(parseImage("ghcr.io/headlamp-k8s/headlamp:v0.45.0"), {
      repo: "headlamp-k8s/headlamp",
      tag: "v0.45.0",
    });
    assert.deepEqual(parseImage("localhost:5000/gitea/gitea"), { repo: "gitea/gitea" });
    assert.deepEqual(parseImage("grafana/grafana:12.0.0"), { repo: "grafana/grafana", tag: "12.0.0" });
    assert.equal(chartName("cert-manager-v1.21.1"), "cert-manager");
    assert.equal(chartName("traefik-40.1.3_up40.1.0"), "traefik");
    assert.equal(chartName("valkey-cluster-3.0.24"), "valkey-cluster");
  });
});

// --- discovery over a real capture ----------------------------------------------

describe("discovery over the real fixture set", () => {
  const set = loadFixtureSet("real");
  const k8s = createFakeK8s({ objects: set.lists, absentGroups: [...new Set(set.absent.map((a) => a.group))] });
  let report: DiscoveryReport;
  before(async () => {
    report = await discover(k8s, catalog);
  });

  test("finds the Helm installs by chart label, with release and version", () => {
    assert.deepEqual(
      ["cert-manager", "longhorn", "gitea"].map((id) => {
        const { state, namespace, release, managedBy } = app(report, id);
        return { id, state, namespace, release, managedBy };
      }),
      [
        {
          id: "cert-manager",
          state: "installed",
          namespace: "cert-manager",
          release: "cert-manager",
          managedBy: "helm",
        },
        { id: "longhorn", state: "installed", namespace: "longhorn-system", release: "longhorn", managedBy: "helm" },
        { id: "gitea", state: "installed", namespace: "git", release: "gitea", managedBy: "helm" },
      ]
    );
    assert.equal(app(report, "cert-manager").version, "v1.21.1");
    assert.match(app(report, "longhorn").evidence, /helm\.sh\/chart=longhorn-/);
  });

  test("finds the rest by the app label or image alone", () => {
    assert.match(app(report, "rancher").evidence, /^Deployment cattle-system\/rancher \(app=rancher\)$/);
    assert.equal(app(report, "rancher").version, "v2.15.0");
    assert.match(app(report, "headlamp").evidence, /\(image ghcr\.io\/headlamp-k8s\/headlamp:/);
    assert.match(app(report, "metrics-server").evidence, /rancher\/mirrored-metrics-server/);
    assert.equal(app(report, "local-path-provisioner").state, "installed");
    // :latest says nothing about the version.
    assert.equal(app(report, "cloudflared").state, "installed");
    assert.equal(app(report, "cloudflared").version, undefined);
  });

  test("apps that are not there are not-installed, never unknown", () => {
    for (const id of ["grafana", "authentik", "velero", "ntfy", "tailscale-operator"]) {
      assert.equal(app(report, id).state, "not-installed", id);
    }
    // A sidecar image from a different repository under the same org must not match.
    assert.ok(!report.apps.some((a) => a.evidence.includes("rancher-webhook")));
  });

  test("Longhorn's backup target counts as installed and hides URL credentials", () => {
    const target = app(report, "longhorn-backup-target");
    assert.equal(target.state, "installed");
    assert.match(target.evidence, /^BackupTarget longhorn-system\/default/);
  });

  test("metrics.k8s.io is served there", () => {
    assert.equal(basic(report, "metrics-server").status, "ok");
  });
});

const nodeObject = (name: string, ready = true, unschedulable = false) => ({
  apiVersion: "v1",
  kind: "Node",
  metadata: { name },
  spec: unschedulable ? { unschedulable } : {},
  status: { conditions: [{ type: "Ready", status: ready ? "True" : "False" }] },
});
const summaryPath = (path: string) => `/api/v1/nodes/${path}/proxy/stats/summary`;

// --- discovery over synthetic clusters ------------------------------------------

describe("discovery over a healthy synthetic cluster", () => {
  let report: DiscoveryReport;
  before(async () => {
    report = await discover(createFakeK8s({ objects: healthyCluster() }), catalog, () => new Date(0));
  });

  test("reports the cluster's Kubernetes version, and leaves it out when it can't be read", async () => {
    assert.equal(report.kubernetesVersion, "v1.31.4+k3s1");
    const k8s = createFakeK8s();
    const silent = await discover(
      {
        ...k8s,
        version: () => Promise.reject(new Error("forbidden")),
      },
      catalog
    );
    assert.equal("kubernetesVersion" in silent, false);
  });

  test("node disks come from each ready node's kubelet summary; failures say why", async () => {
    const GiB = 1024 ** 3;
    const k8s = createFakeK8s({
      objects: [
        {
          ref: RESOURCES.nodes,
          items: [
            nodeObject("n1"),
            nodeObject("n2"),
            nodeObject("n3", false),
            nodeObject("n4", true, true),
            nodeObject("n5"),
          ],
        },
      ],
      raw: {
        [summaryPath("n1")]: {
          node: {
            fs: { availableBytes: 10 * GiB, capacityBytes: 30 * GiB },
            runtime: { imageFs: { availableBytes: 10 * GiB, capacityBytes: 30 * GiB } },
          },
        },
        [summaryPath("n2")]: { node: {} },
      },
    });
    const found = await discover(k8s, catalog);
    assert.deepEqual(found.nodeDisks, [
      {
        node: "n1",
        availableBytes: 10 * GiB,
        capacityBytes: 30 * GiB,
        imageAvailableBytes: 10 * GiB,
        imageCapacityBytes: 30 * GiB,
      },
      { node: "n2", error: "the kubelet reported no filesystem stats" },
      { node: "n3", error: "node not ready" },
      { node: "n5", error: "fake k8s: no raw response for /api/v1/nodes/n5/proxy/stats/summary" },
    ]);
    const hung = await nodeDisks({ ...k8s, raw: () => new Promise(() => {}) }, 10);
    assert.equal(hung?.[0]?.error, "timed out");
    const denied = await nodeDisks({ ...k8s, raw: () => Promise.reject(new Error("403 Forbidden")) });
    assert.equal(denied?.[0]?.error, "forbidden: needs get on nodes/proxy");
    const unlisted = await discover({ ...k8s, list: () => Promise.reject(new Error("forbidden")) }, catalog);
    assert.equal("nodeDisks" in unlisted, false);
  });

  test("Ingress hosts carry scheme by TLS, their service and matched app; wildcards are skipped", () => {
    assert.equal(report.checkedAt, new Date(0).toISOString());
    assert.deepEqual(report.ingressHosts, [
      {
        host: "grafana.home.example.com",
        url: "https://grafana.home.example.com",
        tls: true,
        namespace: "monitoring",
        ingress: "grafana",
        service: "grafana",
        appId: "grafana",
      },
      {
        host: "headlamp.home.example.com",
        url: "http://headlamp.home.example.com",
        tls: false,
        namespace: "headlamp",
        ingress: "headlamp",
        service: "oauth2-proxy",
        appId: "headlamp",
      },
      {
        host: "jellyfin.home.example.com",
        url: "http://jellyfin.home.example.com",
        tls: false,
        namespace: "media",
        ingress: "jellyfin",
        service: "jellyfin",
      },
      {
        host: "solo.other.example.net",
        url: "http://solo.other.example.net",
        tls: false,
        namespace: "other",
        ingress: "solo",
        service: "solo",
      },
    ]);
  });

  test("an app's URLs come from its hosts", () => {
    assert.deepEqual(app(report, "grafana").urls, ["https://grafana.home.example.com"]);
    assert.deepEqual(app(report, "headlamp").urls, ["http://headlamp.home.example.com"]);
    assert.equal(app(report, "grafana").version, "12.2.0");
    assert.equal(app(report, "grafana").release, "grafana");
  });

  test("every basic is ok, and the suggestions follow what is default", () => {
    assert.deepEqual(
      report.basics.map((b) => [b.id, b.status]),
      [
        ["default-storage-class", "ok"],
        ["ingress-controller", "ok"],
        ["cert-manager", "ok"],
        ["metrics-server", "ok"],
      ]
    );
    assert.deepEqual(report.suggested, {
      storageClass: "longhorn",
      ingressClass: "traefik",
      clusterIssuer: "letsencrypt-prod",
      baseDomain: "home.example.com",
    });
    assert.deepEqual(basic(report, "cert-manager").found, ["letsencrypt-prod", "letsencrypt-staging"]);
  });
});

describe("cluster basics, one state at a time", () => {
  test("storage classes: none default is crit with fixes, two defaults is warn without", async () => {
    const none = await run([{ ref: RESOURCES.storageClasses, items: [named("nfs")] }]);
    assert.equal(basic(none, "default-storage-class").status, "crit");
    assert.deepEqual(basic(none, "default-storage-class").fixAppIds, ["local-path-provisioner", "longhorn"]);
    assert.match(basic(none, "default-storage-class").detail, /have: nfs/);
    assert.equal(none.suggested.storageClass, "nfs");

    const empty = await run([]);
    assert.equal(basic(empty, "default-storage-class").status, "crit");
    assert.equal(empty.suggested.storageClass, undefined);

    const two = await run([
      { ref: RESOURCES.storageClasses, items: [named("local-path", DEFAULT_SC), named("longhorn", DEFAULT_SC)] },
    ]);
    assert.equal(basic(two, "default-storage-class").status, "warn");
    assert.deepEqual(basic(two, "default-storage-class").found, ["local-path", "longhorn"]);
    assert.deepEqual(basic(two, "default-storage-class").fixAppIds, []);
    assert.equal(two.suggested.storageClass, "longhorn");

    const beta = await run([
      {
        ref: RESOURCES.storageClasses,
        items: [named("old", { "storageclass.beta.kubernetes.io/is-default-class": "true" })],
      },
    ]);
    assert.equal(basic(beta, "default-storage-class").status, "ok");
  });

  test("ingress classes: none is crit with Traefik, none default is warn", async () => {
    const none = await run([]);
    assert.equal(basic(none, "ingress-controller").status, "crit");
    assert.deepEqual(basic(none, "ingress-controller").fixAppIds, ["traefik"]);

    const plain = await run([{ ref: RESOURCES.ingressClasses, items: [named("nginx")] }]);
    assert.equal(basic(plain, "ingress-controller").status, "warn");
    assert.equal(plain.suggested.ingressClass, "nginx");
  });

  test("cert-manager: absent is crit, no issuer or none Ready is warn", async () => {
    const absent = await run([], ["cert-manager.io"]);
    assert.equal(basic(absent, "cert-manager").status, "crit");
    assert.deepEqual(basic(absent, "cert-manager").fixAppIds, ["cert-manager"]);

    const noIssuer = await run([]);
    assert.equal(basic(noIssuer, "cert-manager").status, "warn");
    assert.deepEqual(basic(noIssuer, "cert-manager").fixAppIds, ["cert-manager"]);

    const notReady = await run([{ ref: RESOURCES.clusterIssuers, items: [issuer("broken", "False")] }]);
    assert.equal(basic(notReady, "cert-manager").status, "warn");
    assert.match(basic(notReady, "cert-manager").detail, /no ClusterIssuer is Ready \(broken\)/);
  });

  test("metrics-server: metrics.k8s.io not served is crit", async () => {
    const absent = await run([], ["metrics.k8s.io"]);
    assert.equal(basic(absent, "metrics-server").status, "crit");
    assert.deepEqual(basic(absent, "metrics-server").fixAppIds, ["metrics-server"]);
  });

  test("an unlistable kind makes the basic unknown, not crit", async () => {
    const k8s = failing(createFakeK8s(), [
      RESOURCES.storageClasses,
      RESOURCES.ingressClasses,
      RESOURCES.clusterIssuers,
    ]);
    const report = await discover(k8s, catalog);
    assert.equal(basic(report, "default-storage-class").status, "unknown");
    assert.equal(basic(report, "ingress-controller").status, "unknown");
    assert.equal(basic(report, "cert-manager").status, "unknown");
  });
});

describe("app detection edge cases", () => {
  test("an unlistable workload kind makes unmatched apps unknown, matched ones stay installed", async () => {
    const k8s = failing(
      createFakeK8s({
        objects: [
          {
            ref: RESOURCES.deployments,
            items: [workload("monitoring", "grafana", { labels: { "app.kubernetes.io/name": "grafana" } })],
          },
        ],
      }),
      [RESOURCES.statefulSets]
    );
    const report = await discover(k8s, catalog);
    assert.equal(app(report, "grafana").state, "installed");
    assert.equal(app(report, "gitea").state, "unknown");
    assert.match(app(report, "gitea").evidence, /StatefulSets could not be listed: forbidden/);
  });

  test("objects carrying the owner label are ownedByUs", async () => {
    const owned = workload("headlamp", "headlamp", {
      labels: { "app.kubernetes.io/name": "headlamp", [OWNER_LABEL]: product.ownerMarker.labelDomain },
    });
    const report = await discover(
      createFakeK8s({ objects: [{ ref: RESOURCES.deployments, items: [owned] }] }),
      catalog
    );
    assert.equal(app(report, "headlamp").ownedByUs, true);
    assert.equal(app(report, "headlamp").managedBy, null);
  });

  test("the deployed-by label, or a deploy release in the same namespace, makes an app ownedByUs", async () => {
    const helm = { "app.kubernetes.io/managed-by": "Helm", "app.kubernetes.io/instance": "x" };
    const objects = [
      {
        ref: RESOURCES.deployments,
        items: [
          workload("monitoring", "grafana", {
            labels: { "app.kubernetes.io/name": "grafana", ...helm, ...deployedLabel() },
          }),
          workload("headlamp", "headlamp", { labels: { "app.kubernetes.io/name": "headlamp", ...helm } }),
          workload("gitea", "gitea", { labels: { "app.kubernetes.io/name": "gitea", ...helm } }),
        ],
      },
    ];
    const releases = [
      { appId: "headlamp", release: "headlamp", namespace: "headlamp", jobId: "dj_1", state: "succeeded" as const },
      { appId: "gitea", release: "gitea", namespace: "elsewhere", jobId: "dj_2", state: "failed" as const },
      { appId: "ntfy", release: "ntfy", namespace: "ntfy", jobId: "dj_3", state: "failed" as const },
    ];
    const report = await discover(createFakeK8s({ objects }), catalog, () => new Date(0), releases);
    assert.deepEqual(
      ["grafana", "headlamp", "gitea", "ntfy"].map((id) => [id, app(report, id).ownedByUs]),
      [
        ["grafana", true],
        ["headlamp", true],
        ["gitea", false],
        ["ntfy", false],
      ]
    );
    assert.equal(app(report, "grafana").managedBy, "helm");
  });

  test("a label match beats an image-only match elsewhere", async () => {
    const report = await discover(
      createFakeK8s({
        objects: [
          {
            ref: RESOURCES.deployments,
            items: [
              workload("aaa", "copy", { image: "grafana/grafana:11.0.0" }),
              workload("monitoring", "grafana", { labels: { "app.kubernetes.io/name": "grafana" } }),
            ],
          },
        ],
      }),
      catalog
    );
    assert.equal(app(report, "grafana").namespace, "monitoring");
  });

  test("Longhorn backup target: absent Longhorn, no URL, and credentials masked", async () => {
    const absent = await discover(createFakeK8s({ absentGroups: ["longhorn.io"] }), catalog);
    assert.equal(app(absent, "longhorn-backup-target").state, "not-installed");

    const empty = await discover(
      createFakeK8s({ objects: [{ ref: RESOURCES.longhornBackupTargets, items: [backupTarget("")] }] }),
      catalog
    );
    assert.equal(app(empty, "longhorn-backup-target").state, "not-installed");

    const s3 = await discover(
      createFakeK8s({
        objects: [
          { ref: RESOURCES.longhornBackupTargets, items: [backupTarget("s3://key:hunter2@bucket@us-east-1/")] },
        ],
      }),
      catalog
    );
    assert.equal(app(s3, "longhorn-backup-target").state, "installed");
    assert.ok(!app(s3, "longhorn-backup-target").evidence.includes("hunter2"));
  });

  test("base domain is the parent most hosts share", () => {
    assert.equal(baseDomain(["a.example.com", "b.example.com", "c.lab.example.org"]), "example.com");
    assert.equal(baseDomain(["example.com"]), undefined);
    assert.equal(baseDomain([]), undefined);
  });
});

// --- bundles ----------------------------------------------------------------

describe("deploy bundles", () => {
  test("every item is a catalog app, after its requires, with inputs that exist", () => {
    for (const bundle of bundles) {
      const shared = new Set(bundle.inputs.map((i) => i.key));
      assert.ok(shared.has("baseDomain"), bundle.id);
      bundle.items.forEach((item, index) => {
        const entry = catalog.find((e) => e.id === item.appId);
        assert.ok(entry, item.appId);
        const keys = new Set(entry.inputs.map((i) => i.key));
        const earlier = bundle.items.slice(0, index).map((i) => i.appId);
        for (const id of entry.requires) assert.ok(earlier.includes(id), `${item.appId} requires ${id}`);
        for (const [appKey, sharedKey] of Object.entries(item.bind ?? {})) {
          assert.ok(keys.has(appKey) && shared.has(sharedKey), `${item.appId} bind ${appKey}`);
        }
        for (const key of Object.keys(item.values ?? {})) assert.ok(keys.has(key), `${item.appId} value ${key}`);
        if (item.hostPrefix) assert.ok(keys.has("host"), `${item.appId} hostPrefix`);
        // Every required secret input is filled from the shared answers.
        for (const input of entry.inputs.filter((i) => i.required && i.default === undefined)) {
          const filled =
            input.key === "host" ||
            shared.has(input.key) ||
            Object.hasOwn(item.bind ?? {}, input.key) ||
            Object.hasOwn(item.values ?? {}, input.key);
          assert.ok(filled, `${item.appId}.${input.key} has no value in the bundle`);
        }
      });
    }
  });

  test("on an empty cluster everything is in, optional Longhorn included, its open-iscsi need a note", async () => {
    const empty = createFakeK8s({ absentGroups: ["cert-manager.io", "metrics.k8s.io"] });
    const view = bundleView(bundles[0]!, await discover(empty, catalog), catalog);
    for (const item of view.items) {
      assert.deepEqual([item.appId, item.skip, item.selected, item.reason], [item.appId, false, true, undefined]);
    }
    assert.match(view.items.find((i) => i.appId === "longhorn")!.note!, /open-iscsi/);
  });

  test("an optional app whose chart doesn't support the cluster starts unticked, with the reason", async () => {
    const empty = createFakeK8s({ absentGroups: ["cert-manager.io", "metrics.k8s.io"] });
    const report = await discover(empty, catalog);
    const view = bundleView(bundles[0]!, { ...report, kubernetesVersion: "v1.20.3" }, catalog);
    const longhorn = view.items.find((i) => i.appId === "longhorn")!;
    assert.deepEqual([longhorn.skip, longhorn.selected], [false, false]);
    assert.match(longhorn.reason!, /^Needs Kubernetes .*this cluster runs v1\.20\.3\.$/);
  });

  test("on a healthy cluster, installed apps and met basics are skipped", async () => {
    const view = bundleView(
      bundles[0]!,
      await discover(createFakeK8s({ objects: healthyCluster() }), catalog),
      catalog
    );
    const skipped = view.items.filter((i) => i.skip).map((i) => i.appId);
    assert.deepEqual(skipped, [
      "traefik",
      "cert-manager",
      "metrics-server",
      "local-path-provisioner",
      "grafana",
      "headlamp",
    ]);
    assert.equal(view.items.find((i) => i.appId === "grafana")!.reason, "Already installed");
    assert.match(view.items.find((i) => i.appId === "traefik")!.reason!, /^Already covered: IngressClass traefik/);
    assert.deepEqual(
      view.items.filter((i) => i.selected).map((i) => i.appId),
      ["longhorn", "authentik", "gitea", "ntfy"]
    );
    assert.deepEqual(view.suggested, { baseDomain: "home.example.com", storageClass: "longhorn" });
  });
});

// --- the service ------------------------------------------------------------

describe("catalog service caching", () => {
  test("a failing releases() reads as none; invalidate drops the cached look", async () => {
    const { k8s, lists } = counting();
    const service = createCatalogService({
      k8s: () => k8s,
      entries: catalog,
      releases: () => Promise.reject(new Error("deploy module down")),
    });
    await service.discover();
    const perLook = lists();
    service.invalidate();
    await service.discover();
    assert.equal(lists(), 2 * perLook);
  });

  test("reuses a recent look, refresh forces a new one, and expiry does too", async () => {
    let now = 1_000;
    const { k8s, lists } = counting();
    const service = createCatalogService({ k8s: () => k8s, entries: catalog, ttlMs: 30_000, now: () => now });
    await service.discover();
    const perLook = lists();
    assert.ok(perLook > 0);
    await service.discover();
    assert.equal(lists(), perLook);
    await service.discover(true);
    assert.equal(lists(), 2 * perLook);
    now += 30_000;
    await service.discover();
    assert.equal(lists(), 3 * perLook);
  });

  test("concurrent callers share one look, and get their own copies", async () => {
    const { k8s, lists } = counting();
    const service = createCatalogService({ k8s: () => k8s, entries: catalog });
    const [a, b] = await Promise.all([service.discover(), service.discover()]);
    const perLook = lists();
    await service.discover();
    assert.equal(lists(), perLook);
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
  });

  test("entries and get", () => {
    const service = createCatalogService({ k8s: () => createFakeK8s(), entries: catalog });
    assert.equal(service.entries(), catalog);
    assert.equal(service.get("headlamp")?.name, "Headlamp");
    assert.equal(service.get("nope"), undefined);
  });
});

// --- HTTP -------------------------------------------------------------------

describe("catalog routes", () => {
  let mock: MockContext;
  let server: { url: string; close(): Promise<void> };
  let lists = 0;

  before(async () => {
    const k8s = createFakeK8s({ objects: healthyCluster() });
    const counted: K8sApi = {
      ...k8s,
      list: async (ref, options) => {
        lists++;
        return k8s.list(ref, options);
      },
    };
    mock = createMockContext("catalog", {
      services: { k8s: counted, deploy: createMockDeployService() },
      user: mockViewer,
    });
    await mod.register(mock.ctx);
    server = await listen(mock.app);
  });
  after(async () => {
    await server.close();
    await mock.close();
  });

  async function get<T>(path: string, expect = 200): Promise<T> {
    const res = await fetch(`${server.url}/api/catalog${path}`);
    const body = (await res.json()) as T;
    assert.equal(res.status, expect, JSON.stringify(body));
    return body;
  }

  test("provides the catalog service", async () => {
    const service: CatalogService = mock.ctx.services.get("catalog");
    assert.equal(service.entries().length, catalog.length);
    assert.equal((await service.discover()).apps.length, catalog.length);
  });

  test("apps the deploy module installed are ownedByUs, and a finished deploy forces a new look", async () => {
    const service = mock.ctx.services.get("catalog");
    const report = await service.discover();
    assert.equal(app(report, "headlamp").ownedByUs, true);
    assert.equal(app(report, "grafana").ownedByUs, false);
    const seen = lists;
    await service.discover();
    assert.equal(lists, seen);
    mock.ctx.bus.emit("deploy.finished", { jobId: "dj_9", appId: "ntfy", mode: "install", state: "succeeded" });
    await new Promise((resolve) => setImmediate(resolve));
    await service.discover();
    assert.ok(lists > seen);
  });

  test("apps lists every entry with what was detected, to a signed-in non-admin", async () => {
    const apps = await get<CatalogAppView[]>("/apps");
    assert.deepEqual(
      apps.map((a) => a.id),
      catalog.map((e) => e.id)
    );
    const grafana = apps.find((a) => a.id === "grafana")!;
    assert.equal(grafana.detected.state, "installed");
    assert.deepEqual(grafana.detected.urls, ["https://grafana.home.example.com"]);
  });

  test("slot filters, and an unknown slot is a 400", async () => {
    const links = await get<CatalogAppView[]>("/apps?slot=links");
    assert.deepEqual(links.map((a) => a.id).toSorted(), ["gitea", "grafana", "headlamp", "longhorn", "rancher"]);
    await get("/apps?slot=nope", 400);
  });

  test("one app by id, 404 for an unknown one", async () => {
    const headlamp = await get<CatalogAppView>("/apps/headlamp");
    assert.equal(headlamp.detected.appId, "headlamp");
    assert.equal(headlamp.install.kind, "helm");
    await get("/apps/nope", 404);
  });

  test("bundles, default first, with the service listing the same", async () => {
    const views = await get<CatalogBundleView[]>("/bundles");
    assert.deepEqual(
      views.map((b) => b.id),
      ["self-hosted"]
    );
    assert.equal(mock.ctx.services.get("catalog").bundles()[0]!.id, "self-hosted");
    assert.ok(views[0]!.items.find((i) => i.appId === "grafana")!.skip);
  });

  test("discovery, with refresh", async () => {
    const report = await get<DiscoveryReport>("/discovery?refresh=1");
    assert.equal(report.apps.length, catalog.length);
    assert.equal(report.suggested.baseDomain, "home.example.com");
  });
});

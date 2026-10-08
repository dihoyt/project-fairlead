import { test } from "node:test";
import assert from "node:assert/strict";
import type { CatalogEntry, DetectedApp, DiscoveryReport } from "../../../src/contracts/catalog.js";
import { mockCatalog, mockDiscovery } from "../../../src/contracts/mocks/catalog.js";
import {
  installOrder,
  notesBetween,
  upgradeReport,
  upgradeSteps,
  type ReportInput,
} from "../../../src/modules/deploy/upgrades.js";

const entry = (id: string) => mockCatalog.find((e) => e.id === id)!;

const ours = (appId: string, extra: Partial<DetectedApp> = {}): DetectedApp => ({
  appId,
  state: "installed",
  namespace: entry(appId).namespace,
  release: appId,
  urls: [`https://${appId}.example.test`],
  evidence: "mock",
  managedBy: "helm",
  ownedByUs: true,
  ...extra,
});

const gitea: CatalogEntry = {
  ...entry("gitea"),
  install: { kind: "helm", repo: "oci://docker.gitea.com/charts", chart: "gitea", version: "12.7.0" },
  upgradeNotes: [
    { version: "11.0.0", note: "old" },
    { version: "12.7.0", note: "Back up first." },
    { version: "13.0.0", note: "future" },
  ],
};
const longhorn: CatalogEntry = {
  ...entry("longhorn"),
  install: {
    kind: "helm",
    repo: "https://charts.longhorn.io",
    chart: "longhorn",
    version: "1.13.0",
    kubeVersion: ">=1.34.0-0",
    fallbacks: [{ version: "1.12.1", kubeVersion: ">=1.25.0-0" }],
  },
};

function input(over: Partial<ReportInput> = {}, apps: DetectedApp[] = []): ReportInput {
  const discovery: DiscoveryReport = { ...mockDiscovery, kubernetesVersion: "v1.31.4+k3s1", apps };
  return {
    entries: [gitea, longhorn, entry("ntfy"), entry("headlamp"), entry("grafana")],
    discovery,
    enabled: true,
    releases: [],
    versions: new Map(),
    busy: new Set(),
    checkedAt: "2026-10-08T00:00:00.000Z",
    ...over,
  };
}

test("lists only apps installed by us, each against the version the cluster can run", () => {
  const report = upgradeReport(
    input(
      {
        versions: new Map([
          ["gitea", "12.1.0"],
          ["longhorn", "1.12.1"],
        ]),
      },
      [ours("gitea"), ours("longhorn"), { ...ours("grafana"), ownedByUs: false }]
    )
  );
  assert.deepEqual(
    report.apps.map((app) => [app.appId, app.state, app.currentVersion, app.targetVersion]),
    [
      ["gitea", "available", "12.1.0", "12.7.0"],
      ["longhorn", "current", "1.12.1", "1.12.1"],
    ]
  );
  const [g, l] = report.apps;
  assert.deepEqual(g!.notes, [{ version: "12.7.0", note: "Back up first." }]);
  assert.match(g!.commands[0]!, /^helm upgrade gitea oci:\/\/docker\.gitea\.com\/charts\/gitea --version 12\.7\.0 /);
  assert.match(g!.commands[0]!, /--reset-then-reuse-values/);
  assert.doesNotMatch(g!.commands[0]!, /--install/);
  assert.equal(l!.fellBack, true);
  assert.match(l!.reason!, /1\.13\.0 needs Kubernetes >=1\.34\.0-0; this cluster runs v1\.31\.4\+k3s1/);
});

test("never offers a downgrade, and says when the version is unknown", () => {
  const report = upgradeReport(
    input({ versions: new Map([["gitea", "13.0.0"]]) }, [ours("gitea"), ours("ntfy"), ours("headlamp")])
  );
  const by = Object.fromEntries(report.apps.map((app) => [app.appId, app]));
  assert.equal(by.gitea!.state, "current");
  assert.match(by.gitea!.reason!, /Newer than/);
  assert.equal(by.ntfy!.state, "unknown");
  assert.deepEqual(by.ntfy!.commands, ["kubectl apply -f /values/manifest.yaml"]);
  assert.equal(by.headlamp!.state, "unknown");
});

test("falls back to the chart version discovery read", () => {
  const report = upgradeReport(input({}, [ours("gitea", { chartVersion: "12.1.0" })]));
  assert.equal(report.apps[0]!.state, "available");
  assert.equal(report.apps[0]!.currentVersion, "12.1.0");
});

test("blocks while deploys are off or a job for the release runs", () => {
  const versions = new Map([["gitea", "12.1.0"]]);
  assert.equal(upgradeReport(input({ enabled: false, versions }, [ours("gitea")])).apps[0]!.state, "blocked");
  const busy = upgradeReport(input({ busy: new Set(["gitea"]), versions }, [ours("gitea")])).apps[0]!;
  assert.equal(busy.state, "blocked");
  assert.match(busy.reason!, /running/);
});

test("without discovery, the runner's record of a succeeded install stands in", () => {
  const report = upgradeReport(
    input({
      discovery: undefined,
      releases: [{ appId: "gitea", release: "gitea", namespace: "gitea", jobId: "dj_1", state: "succeeded" }],
      versions: new Map([["gitea", "12.1.0"]]),
    })
  );
  assert.deepEqual(
    report.apps.map((app) => app.appId),
    ["gitea"]
  );
});

test("notes cover (from, to], all up to the target when from is unknown", () => {
  assert.deepEqual(
    notesBetween(gitea.upgradeNotes, undefined, "12.7.0").map((n) => n.version),
    ["11.0.0", "12.7.0"]
  );
  assert.deepEqual(notesBetween(gitea.upgradeNotes, "12.7.0", "12.7.0"), []);
});

test("install order puts requires first", () => {
  const rancher = entry("rancher");
  const order = installOrder([rancher, entry("cert-manager")]).map((e) => e.id);
  assert.ok(order.indexOf("cert-manager") < order.indexOf("rancher"));
});

test("a manifest upgrade applies the pinned manifest only", () => {
  const steps = upgradeSteps({ entry: entry("ntfy"), release: "ntfy", namespace: "ntfy" }, "v0.0.0-mock");
  assert.deepEqual(Object.keys(steps.files), ["manifest.yaml"]);
  assert.equal(steps.steps.length, 1);
});

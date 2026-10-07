import { test } from "node:test";
import assert from "node:assert/strict";
import { RESOURCES } from "../../../src/contracts/k8s.js";
import type { K8sApi } from "../../../src/contracts/k8s.js";
import type { CheckResult } from "../../../src/contracts/health.js";
import { createMockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { HOUR, MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import mod from "../../../src/modules/fleet/index.js";
import {
  commitUrl,
  fleetHealthProvider,
  judgeAll,
  rancherUrl,
  repoWebUrl,
  type Bundle,
  type GitRepo,
  type JudgeOptions,
} from "../../../src/modules/fleet/provider.js";
import { fixtureItems, loadFixtureSet, scenarios } from "../../support/index.js";

const fixtures = loadFixtureSet("synthetic");
const repos = () => structuredClone(fixtureItems(fixtures, RESOURCES.fleetGitRepos)) as GitRepo[];
const bundles = () => structuredClone(fixtureItems(fixtures, RESOURCES.fleetBundles)) as Bundle[];
const { ready, notReady } = scenarios.fleet;
const COMMIT = "4f9a1c7e2b3d5a60918f7e6d5c4b3a291807f6e5";
const MIN = 60_000;

const opts = (over: Partial<JudgeOptions> = {}): JudgeOptions => ({
  now: new Date(MOCK_NOW),
  graceMs: 10 * MIN,
  severity: {},
  rancherUrl: "",
  ...over,
});

const byId = (results: CheckResult[], id: string) => {
  const found = results.find((r) => r.id === id);
  assert.ok(found, `no result ${id} in ${results.map((r) => r.id).join(", ")}`);
  return found;
};
const sync = (name: string) => `gitrepo/fleet-default/${name}/sync`;
const deploy = (name: string) => `gitrepo/fleet-default/${name}/deploy`;

// The ready GitRepo and its bundle, reshaped into another Fleet state.
function variant(
  state: string,
  summary: Record<string, unknown>,
  readyChangedAgoMs: number
): { repos: GitRepo[]; bundles: Bundle[] } {
  const repo = repos().find((r) => r.metadata.name === ready)!;
  const bundle = bundles().find((b) => b.metadata.labels?.["fleet.cattle.io/repo-name"] === ready)!;
  const changed = new Date(MOCK_NOW - readyChangedAgoMs).toISOString();
  const conditions = [{ type: "Ready", status: "False", lastUpdateTime: changed, lastTransitionTime: changed }];
  repo.status = {
    ...repo.status,
    summary,
    display: { state, message: `${state}(1) [Bundle ${bundle.metadata.name}]` },
    conditions,
  };
  bundle.status = { ...bundle.status, summary, display: { state, readyClusters: "0/1" }, conditions };
  return { repos: [repo], bundles: [bundle] };
}

test("ready GitRepo: sync and deployments ok, commit linked without credentials", () => {
  const results = judgeAll(repos(), bundles(), opts());
  const s = byId(results, sync(ready));
  assert.equal(s.status, "ok");
  assert.equal(s.value, "4f9a1c7");
  assert.equal(s.detail, "At 4f9a1c7 on branch main");
  assert.equal(s.deepLink, `https://git.example.lan/ops/cluster/commit/${COMMIT}`);
  assert.equal(s.raw, undefined);
  const d = byId(results, deploy(ready));
  assert.equal(d.status, "ok");
  assert.equal(d.value, 0);
  assert.match(d.detail, /^1\/1 bundle deployments ready, 1\/1 clusters$/);
  assert.ok(!JSON.stringify(results).includes("REDACTED@"), "a remote's userinfo never reaches a result");
});

test("not-ready GitRepo: warn inside the grace period, crit once it persists", () => {
  const young = byId(judgeAll(repos(), bundles(), opts()), deploy(notReady));
  assert.equal(young.status, "warn");
  assert.match(young.detail, /0\/1 bundle deployments ready/);
  assert.match(young.detail, /1 NotReady/);
  assert.match(young.detail, /cluster-addons-cert-issuers/);
  assert.ok(young.raw, "a failing check carries raw");

  const old = byId(judgeAll(repos(), bundles(), opts({ now: new Date(MOCK_NOW + HOUR) })), deploy(notReady));
  assert.equal(old.status, "crit");
  // Sync is a separate question: the commit was fetched fine.
  assert.equal(byId(judgeAll(repos(), bundles(), opts()), sync(notReady)).status, "ok");
});

test("modified: drift is a warning naming the changed resources", () => {
  const v = variant(
    "Modified",
    {
      desiredReady: 1,
      ready: 0,
      modified: 1,
      nonReadyResources: [
        {
          name: `${ready}-web`,
          bundleState: "Modified",
          modifiedStatus: [
            { apiVersion: "apps/v1", kind: "Deployment", namespace: "default", name: "web", patch: '{"spec":{}}' },
            { apiVersion: "v1", kind: "ConfigMap", namespace: "default", name: "web-config", missing: true },
          ],
        },
      ],
    },
    2 * HOUR
  );
  const d = byId(judgeAll(v.repos, v.bundles, opts()), deploy(ready));
  assert.equal(d.status, "warn");
  assert.equal(d.value, 1);
  assert.match(d.detail, /1 Modified/);
  assert.match(d.detail, /drift: Deployment default\/web modified, ConfigMap default\/web-config missing/);
  assert.equal((d.raw as { drift: unknown[] }).drift.length, 2);
});

test("errored: ErrApplied is critical even inside the grace period", () => {
  const v = variant(
    "ErrApplied",
    {
      desiredReady: 1,
      ready: 0,
      errApplied: 1,
      nonReadyResources: [{ name: `${ready}-web`, bundleState: "ErrApplied", message: "admission webhook denied" }],
    },
    1 * MIN
  );
  const d = byId(judgeAll(v.repos, v.bundles, opts()), deploy(ready));
  assert.equal(d.status, "crit");
  assert.match(d.detail, /1 ErrApplied/);
  assert.match(d.detail, /ErrApplied\(1\)/);
});

test("out of sync: a rollout in progress is ok, a stalled one warns", () => {
  const summary = { desiredReady: 1, ready: 0, outOfSync: 1 };
  const rolling = variant("OutOfSync", summary, 2 * MIN);
  const r = byId(judgeAll(rolling.repos, rolling.bundles, opts()), deploy(ready));
  assert.equal(r.status, "ok");
  assert.match(r.detail, /1 OutOfSync; bundles: cluster-apps-web; rolling out$/);

  const stalled = variant("OutOfSync", summary, 30 * MIN);
  const s = byId(judgeAll(stalled.repos, stalled.bundles, opts()), deploy(ready));
  assert.equal(s.status, "warn");
  assert.match(s.detail, /1 OutOfSync/);
});

test("sync failures: git polling, stalled and failed jobs are critical with the reason", () => {
  const cases: Array<[string, (r: GitRepo) => void, RegExp]> = [
    [
      "polling",
      (r) => r.status!.conditions!.push({ type: "GitPolling", status: "False", message: "authentication required" }),
      /Cannot sync branch main: authentication required \(last commit 4f9a1c7\)/,
    ],
    [
      "stalled",
      (r) => r.status!.conditions!.push({ type: "Stalled", status: "True", message: "no such path apps" }),
      /no such path apps/,
    ],
    ["job", (r) => (r.status!.gitJobStatus = "Failed"), /Git job failed/],
  ];
  for (const [what, mutate, detail] of cases) {
    const list = repos();
    mutate(list.find((r) => r.metadata.name === ready)!);
    const s = byId(judgeAll(list, bundles(), opts()), sync(ready));
    assert.equal(s.status, "crit", what);
    assert.match(s.detail, detail, what);
    assert.equal((s.raw as { repo: string }).repo, "https://git.example.lan/ops/cluster.git", what);
  }
});

test("paused and never-fetched GitRepos", () => {
  const list = repos();
  const repo = list.find((r) => r.metadata.name === ready)!;
  repo.spec!.paused = true;
  const paused = byId(judgeAll(list, [], opts()), sync(ready));
  assert.equal(paused.status, "warn");
  assert.equal(paused.detail, "Paused at 4f9a1c7 on branch main");

  delete repo.spec!.paused;
  delete repo.status!.commit;
  // Created 45 days ago, so long past the grace period.
  const none = byId(judgeAll(list, [], opts()), sync(ready));
  assert.equal(none.status, "warn");
  assert.match(none.detail, /No commit fetched yet/);
  assert.equal(none.deepLink, "https://git.example.lan/ops/cluster");
});

test("severity setting overrides a state's default", () => {
  const v = variant("Modified", { desiredReady: 1, ready: 0, modified: 1 }, HOUR);
  assert.equal(
    byId(judgeAll(v.repos, v.bundles, opts({ severity: { Modified: "crit" } })), deploy(ready)).status,
    "crit"
  );
  assert.equal(byId(judgeAll(v.repos, v.bundles, opts({ severity: { Modified: "ok" } })), deploy(ready)).status, "ok");
});

test("Rancher links when configured", () => {
  const results = judgeAll(repos(), bundles(), opts({ rancherUrl: "https://rancher.example.com/" }));
  assert.equal(
    byId(results, deploy(ready)).deepLink,
    `https://rancher.example.com/dashboard/c/_/fleet/fleet.cattle.io.gitrepo/fleet-default/${ready}`
  );
  // The commit stays the sync check's link: that is where a sync problem is read.
  assert.equal(byId(results, sync(ready)).deepLink, `https://git.example.lan/ops/cluster/commit/${COMMIT}`);
  assert.equal(
    byId(judgeAll(repos(), bundles(), opts()), deploy(ready)).deepLink,
    commitUrl("https://git.example.lan/ops/cluster.git", COMMIT)
  );
});

test("bundles no GitRepo owns get one check of their own", () => {
  const agent: Bundle = {
    apiVersion: "fleet.cattle.io/v1alpha1",
    kind: "Bundle",
    metadata: { name: "fleet-agent-local", namespace: "fleet-local" },
    status: {
      display: { state: "ErrApplied" },
      summary: { desiredReady: 1, ready: 0, errApplied: 1 },
      conditions: [{ type: "Ready", status: "False" }],
    },
  };
  const results = judgeAll(repos(), [...bundles(), agent], opts({ rancherUrl: "https://rancher.example.com" }));
  const b = byId(results, "bundles");
  assert.equal(b.status, "crit");
  assert.equal(b.detail, "0/1 standalone bundle ready; fleet-local/fleet-agent-local ErrApplied");
  assert.equal(
    b.deepLink,
    "https://rancher.example.com/dashboard/c/_/fleet/fleet.cattle.io.bundle/fleet-local/fleet-agent-local"
  );
  // The fixture's own bundles all belong to a GitRepo.
  assert.equal(
    judgeAll(repos(), bundles(), opts()).find((r) => r.id === "bundles"),
    undefined
  );
});

test("git remote to web URL", () => {
  assert.equal(repoWebUrl("https://user:token@git.example.lan/ops/cluster.git"), "https://git.example.lan/ops/cluster");
  assert.equal(repoWebUrl("https://git.example.lan:3000/ops/cluster/"), "https://git.example.lan:3000/ops/cluster");
  assert.equal(repoWebUrl("git@git.example.lan:ops/cluster.git"), "https://git.example.lan/ops/cluster");
  assert.equal(repoWebUrl("ssh://git@git.example.lan:2222/ops/cluster.git"), "https://git.example.lan/ops/cluster");
  assert.equal(repoWebUrl("file:///srv/repo"), undefined);
  assert.equal(repoWebUrl(undefined), undefined);
  assert.equal(rancherUrl("", "gitrepo", { metadata: { name: "x", namespace: "y" } }), undefined);
});

// --- provider and module -----------------------------------------------------

function fake(extra: { absentGroups?: string[] } = {}) {
  return createFakeK8s({
    objects: [
      { ref: RESOURCES.fleetGitRepos, items: fixtureItems(fixtures, RESOURCES.fleetGitRepos) },
      { ref: RESOURCES.fleetBundles, items: fixtureItems(fixtures, RESOURCES.fleetBundles) },
    ],
    ...extra,
  });
}

const deps = (k8s: () => K8sApi) => ({
  k8s,
  options: () => ({ rancherUrl: "", graceMs: 10 * MIN, severity: {} }),
  now: () => new Date(MOCK_NOW),
});

test("provider: Fleet absent is reported absent, not as an error", async () => {
  const provider = fleetHealthProvider(deps(() => fake({ absentGroups: ["fleet.cattle.io"] })));
  assert.equal(provider.category, "gitops");
  const results = await provider.collect();
  assert.equal(results.length, 1);
  assert.equal(results[0]!.status, "absent");
  assert.equal(results[0]!.detail, "Fleet is not installed");
});

test("provider: unreadable cluster is unknown with the reason", async () => {
  const k8s = fake();
  const broken: K8sApi = { ...k8s, list: async () => Promise.reject(new Error("gitrepos is forbidden")) };
  const results = await fleetHealthProvider(deps(() => broken)).collect();
  assert.equal(results.length, 1);
  assert.equal(results[0]!.status, "unknown");
  assert.match(results[0]!.detail, /gitrepos is forbidden/);
  assert.ok(results[0]!.raw);

  const missing = await fleetHealthProvider(
    deps(() => {
      throw new Error('service "k8s" has not been provided');
    })
  ).collect();
  assert.equal(missing[0]!.status, "unknown");
});

test("provider: installed with no GitRepos is ok", async () => {
  const k8s = createFakeK8s({ objects: [] });
  const results = await fleetHealthProvider(deps(() => k8s)).collect();
  assert.deepEqual(
    results.map((r) => [r.id, r.status, r.detail]),
    [["fleet", "ok", "Fleet is installed; no GitRepos"]]
  );
});

test("module registers one gitops provider that reads its settings each run", async () => {
  const k8s = fake();
  const m = createMockContext("fleet", {
    migrations: mod.migrations ?? [],
    services: { k8s },
    settings: {
      "fleet.rancherUrl": "https://rancher.example.com",
      "fleet.graceMinutes": 0,
      "fleet.severity": { NotReady: "warn" },
    },
  });
  try {
    await mod.register(m.ctx);
    const providers = m.ctx.health.list();
    assert.equal(providers.length, 1);
    const [provider] = providers;
    assert.equal(provider!.id, "fleet");
    assert.equal(provider!.category, "gitops");
    const results = await provider!.collect();
    assert.deepEqual(
      results.map((r) => [r.id, r.status]),
      [
        [sync(notReady), "ok"],
        [deploy(notReady), "warn"],
        [sync(ready), "ok"],
        [deploy(ready), "ok"],
      ]
    );
    assert.match(byId(results, deploy(ready)).deepLink ?? "", /^https:\/\/rancher\.example\.com\/dashboard\//);
  } finally {
    await m.close();
  }
});

test("every result carries a detail and an observedAt", async () => {
  const results = await fleetHealthProvider(deps(() => fake())).collect();
  for (const r of results) {
    assert.ok(r.detail.length > 0, r.id);
    assert.equal(r.observedAt, new Date(MOCK_NOW).toISOString());
    if (r.status !== "ok") assert.ok(r.raw, `${r.id} has raw`);
  }
});

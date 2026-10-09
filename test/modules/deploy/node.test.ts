import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeployActionPlan, DeployJobView } from "../../../src/contracts/deploy.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { createMockCatalogService } from "../../../src/contracts/mocks/catalog.js";
import { createMockContext, type MockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s, type FakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import {
  DRAIN_SCRIPT,
  PDBS,
  REBOOT_SCRIPT,
  drainPods,
  nodeActionEnv,
  rebootPod,
  rebootPodName,
} from "../../../src/modules/deploy/actions/node.js";
import mod, { registerDeploy } from "../../../src/modules/deploy/index.js";
import type { Deployer } from "../../../src/modules/deploy/runner.js";
import { listen } from "../../runtime/helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasTools = ["sh", "python3"].every((tool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0);

const NS = "console";
const IMAGE = "docker.io/alpine/k8s@sha256:1111111111111111111111111111111111111111111111111111111111111111";

const node = (name: string, opts: { ready?: boolean; cordoned?: boolean; controlPlane?: boolean } = {}): KubeObject =>
  ({
    apiVersion: "v1",
    kind: "Node",
    metadata: {
      name,
      labels: opts.controlPlane ? { "node-role.kubernetes.io/control-plane": "true" } : {},
    },
    spec: opts.cordoned ? { unschedulable: true } : {},
    status: { conditions: [{ type: "Ready", status: opts.ready === false ? "False" : "True" }] },
  }) as KubeObject;

const pod = (
  namespace: string,
  name: string,
  owner: string | undefined,
  extra: { node?: string; labels?: Record<string, string>; emptyDir?: boolean; mirror?: boolean; phase?: string } = {}
): KubeObject =>
  ({
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace,
      labels: extra.labels ?? {},
      ...(extra.mirror ? { annotations: { "kubernetes.io/config.mirror": "x" } } : {}),
      ...(owner
        ? {
            ownerReferences: [
              {
                apiVersion: "apps/v1",
                kind: owner.split("/")[0]!,
                name: owner.split("/")[1]!,
                uid: "u",
                controller: true,
              },
            ],
          }
        : {}),
    },
    spec: { nodeName: extra.node ?? "node-2", volumes: extra.emptyDir ? [{ name: "scratch", emptyDir: {} }] : [] },
    status: { phase: extra.phase ?? "Running" },
  }) as KubeObject;

const pdb = (namespace: string, name: string, app: string, allowed: number): KubeObject =>
  ({
    apiVersion: "policy/v1",
    kind: "PodDisruptionBudget",
    metadata: { name, namespace },
    spec: { selector: { matchLabels: { app } } },
    status: { disruptionsAllowed: allowed },
  }) as KubeObject;

function cluster(options: { nodes?: KubeObject[]; pods?: KubeObject[]; pdbs?: KubeObject[] } = {}): FakeK8s {
  return createFakeK8s({
    objects: [
      {
        ref: RESOURCES.nodes,
        items: options.nodes ?? [
          node("node-1", { controlPlane: true }),
          node("node-2"),
          node("node-3", { cordoned: true }),
        ],
      },
      {
        ref: RESOURCES.pods,
        items: options.pods ?? [
          pod("apps", "web-1", "ReplicaSet/web-6d4f"),
          pod("apps", "db-0", "StatefulSet/db", { labels: { app: "db" } }),
          pod("longhorn-system", "longhorn-manager-x", "DaemonSet/longhorn-manager"),
          pod("apps", "elsewhere", "ReplicaSet/web-6d4f", { node: "node-1" }),
        ],
      },
      { ref: PDBS, items: options.pdbs ?? [pdb("apps", "db", "db", 0)] },
    ],
  });
}

interface Env {
  mock: MockContext;
  k8s: FakeK8s;
  deployer: Deployer;
  server: { url: string; close(): Promise<void> };
}

let env: Env | undefined;
const originalConsolePod = nodeActionEnv.consolePod;

async function setup(options: { k8s?: FakeK8s; enabled?: boolean } = {}): Promise<Env> {
  const k8s = options.k8s ?? (options.enabled === false ? createFakeK8s({ denied: ["create batch/jobs"] }) : cluster());
  const mock = createMockContext("deploy", {
    migrations: mod.migrations,
    settings: { "deploy.image": IMAGE, "deploy.namespace": NS, "deploy.release": "console" },
    services: { k8s, catalog: createMockCatalogService() },
  });
  const { deployer } = registerDeploy(mock.ctx, { now: () => MOCK_NOW });
  const server = await listen(mock.app);
  env = { mock, k8s, deployer, server };
  return env;
}

afterEach(async () => {
  nodeActionEnv.consolePod = originalConsolePod;
  if (!env) return;
  env.deployer.stop();
  await env.server.close();
  await env.mock.close();
  env = undefined;
});

async function post<T>(e: Env, path: string, body: unknown, expect = 200): Promise<T> {
  const res = await fetch(`${e.server.url}/api/deploy${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T;
  assert.equal(res.status, expect, JSON.stringify(json));
  return json;
}

const plan = (e: Env, body: unknown) => post<DeployActionPlan>(e, "/actions/plan", body);

test("drainPods follows kubectl drain's filters", () => {
  const pods = [
    pod("apps", "web-1", "ReplicaSet/web"),
    pod("kube-system", "ds-1", "DaemonSet/ds"),
    pod("kube-system", "static", undefined, { mirror: true }),
    pod("apps", "scratch", "ReplicaSet/s", { emptyDir: true }),
    pod("apps", "bare", undefined),
    pod("apps", "done", undefined, { phase: "Succeeded" }),
    pod("apps", "db-0", "StatefulSet/db", { labels: { app: "db" } }),
    pod("apps", "cache-0", "StatefulSet/cache", { labels: { app: "cache" } }),
  ];
  const pdbs = [pdb("apps", "db", "db", 0), pdb("apps", "cache", "cache", 1), pdb("other", "db", "db", 0)];
  const by = (opts: { ignoreDaemonSets: boolean; deleteEmptyDirData: boolean }) =>
    Object.fromEntries(drainPods(pods as never, pdbs as never, opts).map((p) => [p.name, p]));

  const d = by({ ignoreDaemonSets: true, deleteEmptyDirData: false });
  assert.equal(d["web-1"]!.outcome, "evict");
  assert.equal(d["web-1"]!.owner, "ReplicaSet/web");
  assert.equal(d["ds-1"]!.outcome, "skip");
  assert.equal(d.static!.outcome, "skip");
  assert.equal(d.scratch!.outcome, "block");
  assert.match(d.scratch!.reason!, /emptyDir/);
  assert.equal(d.bare!.outcome, "block");
  assert.equal(d.done!.outcome, "evict", "a finished pod is deleted whatever owns it");
  assert.deepEqual([d["db-0"]!.outcome, d["db-0"]!.pdb], ["wait", "db"]);
  assert.equal(d["cache-0"]!.outcome, "evict", "a budget with room left doesn't hold the pod");

  const strict = by({ ignoreDaemonSets: false, deleteEmptyDirData: true });
  assert.equal(strict["ds-1"]!.outcome, "block");
  assert.equal(strict.scratch!.outcome, "evict");
});

test("plan: cordon and uncordon are one kubectl call each; refused when already in that state", async () => {
  const e = await setup();
  const cordon = await plan(e, { kind: "node-cordon", node: "node-2" });
  assert.equal(cordon.allowed, true, cordon.blockedBy);
  assert.equal(cordon.title, "Cordon node-2");
  assert.deepEqual(cordon.steps, [{ label: "Cordon node-2", commands: ["kubectl cordon node-2"] }]);
  assert.deepEqual(cordon.changes, [{ kind: "Node", name: "node-2" }]);
  assert.ok(cordon.creates.some((c) => c.kind === "Job" && c.name.startsWith("deploy-node-node-2-")));

  const again = await plan(e, { kind: "node-cordon", node: "node-3" });
  assert.equal(again.allowed, false);
  assert.match(again.blockedBy!, /already cordoned/);
  const uncordon = await plan(e, { kind: "node-uncordon", node: "node-3" });
  assert.equal(uncordon.allowed, true, uncordon.blockedBy);
  const notCordoned = await plan(e, { kind: "node-uncordon", node: "node-2" });
  assert.match(notCordoned.blockedBy!, /not cordoned/);
  const missing = await plan(e, { kind: "node-cordon", node: "node-9" });
  assert.match(missing.blockedBy!, /no node named node-9/);
  assert.equal(e.k8s.writes.length, 0, "a plan writes nothing");
});

test("plan: a drain lists each pod's outcome and names the budget it waits on; the console's pod warns", async () => {
  nodeActionEnv.consolePod = () => ({ name: "web-1", namespace: "apps" });
  const e = await setup();
  const drain = await plan(e, { kind: "node-drain", node: "node-2" });
  assert.equal(drain.allowed, true, drain.blockedBy);
  assert.deepEqual(
    drain.pods?.map((p) => `${p.name}:${p.outcome}`),
    ["web-1:evict", "db-0:wait", "longhorn-manager-x:skip"]
  );
  assert.equal(drain.pods?.find((p) => p.name === "db-0")?.pdb, "db");
  assert.deepEqual(
    drain.steps.map((s) => s.commands),
    [["kubectl drain node-2 --ignore-daemonsets=true --delete-emptydir-data=false --timeout=300s"]]
  );
  assert.ok(drain.warnings.some((w) => w.includes("this console's own pod")));
  assert.ok(drain.warnings.some((w) => w.includes("apps/db") && w.includes("300s")));
  assert.match(drain.rollback!, /stays cordoned/);
});

test("plan: a pod that would stop the drain blocks it; options change the outcome", async () => {
  const e = await setup({
    k8s: cluster({
      pods: [pod("apps", "scratch", "ReplicaSet/s", { emptyDir: true }), pod("apps", "bare", undefined)],
    }),
  });
  const blocked = await plan(e, { kind: "node-drain", node: "node-2" });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.blockedBy!, /2 pods would stop the drain/);
  assert.equal(blocked.pods?.length, 2);

  const still = await plan(e, { kind: "node-drain", node: "node-2", deleteEmptyDirData: true });
  assert.match(still.blockedBy!, /1 pod would stop the drain \(apps\/bare\)/);
});

test("plan: the only node is never drained or rebooted", async () => {
  const e = await setup({ k8s: cluster({ nodes: [node("solo", { controlPlane: true })], pods: [] }) });
  const drain = await plan(e, { kind: "node-drain", node: "solo" });
  assert.equal(drain.allowed, false);
  assert.match(drain.blockedBy!, /only node; draining it/);
  const reboot = await plan(e, { kind: "node-reboot", node: "solo" });
  assert.match(reboot.blockedBy!, /only node; rebooting it/);
  const cordon = await plan(e, { kind: "node-cordon", node: "solo" });
  assert.equal(cordon.allowed, true, "cordon alone moves nothing");
});

test("plan: reboot drains, reboots through a pinned privileged pod, waits and uncordons", async () => {
  const e = await setup({
    k8s: cluster({ nodes: [node("node-1", { controlPlane: true }), node("node-2"), node("node-4", { ready: false })] }),
  });
  const reboot = await plan(e, { kind: "node-reboot", node: "node-2", timeoutSeconds: 120 });
  assert.equal(reboot.allowed, true, reboot.blockedBy);
  assert.deepEqual(
    reboot.steps.map((s) => s.label),
    [
      "Cordon node-2 and evict 2 pods",
      "Reboot node-2",
      "Wait up to 15 minutes for node-2 to come back Ready",
      "Uncordon node-2",
    ]
  );
  assert.ok(reboot.creates.some((c) => c.kind === "Pod" && c.namespace === "kube-system"));
  assert.ok(reboot.warnings.some((w) => w.includes("privileged pod")));

  const down = await plan(e, { kind: "node-reboot", node: "node-4" });
  assert.match(down.blockedBy!, /not Ready/);

  const lastControlPlane = await plan(e, { kind: "node-reboot", node: "node-1" });
  assert.ok(lastControlPlane.warnings.some((w) => w.includes("only control-plane node")));
});

test("plan: deploys off gives the enable hint; bad input is refused at the route", async () => {
  const e = await setup({
    k8s: createFakeK8s({ objects: [{ ref: RESOURCES.nodes, items: [node("node-2")] }], denied: ["create batch/jobs"] }),
  });
  const off = await plan(e, { kind: "node-cordon", node: "node-2" });
  assert.equal(off.allowed, false);
  assert.match(off.blockedBy!, /^Deploys are off\./);
  await post(e, "/actions/plan", { kind: "node-cordon", node: "Bad Name" }, 400);
  await post(e, "/actions/plan", { kind: "node-drain", node: "node-2", timeoutSeconds: 5 }, 400);
  await post(e, "/actions/plan", { kind: "node-drain", node: "node-2", force: true }, 200);
});

test("run: a drain is a node-<name> job kept off that node, with the options as files", async () => {
  const e = await setup();
  const view = await post<DeployJobView>(e, "/actions/run", { kind: "node-drain", node: "node-2" });
  assert.equal(view.action, "node-drain");
  assert.equal(view.release, "node-node-2");
  assert.equal(view.appId, "node-node-2");
  const job = e.k8s.writes.find((w) => w.verb === "create" && w.ref.plural === "jobs");
  assert.ok(job);
  const created = (await e.k8s.get(RESOURCES.jobs, job.name, NS)) as KubeObject & {
    spec: { template: { spec: { affinity: unknown; containers: Array<{ command: string[] }> } } };
  };
  assert.deepEqual(created.spec.template.spec.affinity, {
    nodeAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: {
        nodeSelectorTerms: [
          { matchExpressions: [{ key: "kubernetes.io/hostname", operator: "NotIn", values: ["node-2"] }] },
        ],
      },
    },
  });
  assert.equal(created.spec.template.spec.containers[0]!.command[2], DRAIN_SCRIPT);
  const secret = (await e.k8s.list(RESOURCES.secrets, { namespace: NS })) as Array<
    KubeObject & { stringData?: Record<string, string>; data?: Record<string, string> }
  >;
  const files =
    secret[0]!.stringData ??
    Object.fromEntries(Object.entries(secret[0]!.data ?? {}).map(([k, v]) => [k, Buffer.from(v, "base64").toString()]));
  assert.equal(files.node, "node-2");
  assert.equal(files["ignore-daemonsets"], "true");
  assert.equal(files["delete-emptydir-data"], "false");
  assert.equal(files.timeout, "300");

  await post(e, "/actions/run", { kind: "node-cordon", node: "node-2" }, 409);
});

test("rebootPod runs a fixed command in the host's namespaces, pinned to the node", () => {
  const p = rebootPod("node-2", IMAGE) as KubeObject & { spec: Record<string, unknown> };
  const spec = p.spec as {
    nodeName: string;
    hostPID: boolean;
    tolerations: unknown[];
    containers: Array<{ image: string; command: string[]; securityContext: { privileged: boolean } }>;
  };
  assert.equal(p.metadata.namespace, "kube-system");
  assert.equal(spec.nodeName, "node-2");
  assert.equal(spec.hostPID, true);
  assert.deepEqual(spec.tolerations, [{ operator: "Exists" }]);
  assert.equal(spec.containers[0]!.image, IMAGE);
  assert.equal(spec.containers[0]!.securityContext.privileged, true);
  assert.deepEqual(spec.containers[0]!.command.slice(-2), ["systemctl", "reboot"]);
});

// --- the scripts, under sh against a fake kubectl ---------------------------

interface ScriptState {
  calls: string[];
  unschedulable: boolean;
  bootID: string;
  pdbs?: KubeObject[];
  drainFails?: boolean;
  rebootFails?: boolean;
  neverReturns?: boolean;
  rebootPhase?: string;
  created?: KubeObject;
}

function runScript(script: string, state: Partial<ScriptState> = {}, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "node-action-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, "values"));
  writeFileSync(join(bin, "kubectl"), `#!/bin/sh\nexec python3 ${join(here, "fake-kubectl-node.py")} "$@"\n`);
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\n");
  writeFileSync(
    join(bin, "jq"),
    `#!/bin/sh\nexec python3 -c 'import json,sys\nfor p in json.load(sys.stdin)["items"]:\n  if (p.get("status",{}).get("disruptionsAllowed") or 0)==0: print("  %s/%s" % (p["metadata"]["namespace"], p["metadata"]["name"]))'\n`
  );
  for (const tool of ["kubectl", "sleep", "jq"]) chmodSync(join(bin, tool), 0o755);
  const values = {
    node: "node-2",
    "ignore-daemonsets": "true",
    "delete-emptydir-data": "false",
    timeout: "300",
    "pod-name": rebootPodName("node-2"),
    "reboot-wait": "900",
    "reboot-pod.json": JSON.stringify(rebootPod("node-2", IMAGE)),
    ...files,
  };
  for (const [name, body] of Object.entries(values)) writeFileSync(join(dir, "values", name), body);
  const stateFile = join(dir, "state.json");
  writeFileSync(stateFile, JSON.stringify({ calls: [], unschedulable: false, bootID: "boot-a", ...state }));
  const result = spawnSync("sh", ["-c", script.replaceAll("/values/", `${dir}/values/`)], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: stateFile },
  });
  const out = {
    status: result.status,
    lines: `${result.stdout}`.trim().split("\n"),
    stderr: result.stderr,
    state: JSON.parse(readFileSync(stateFile, "utf8")) as ScriptState,
  };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

test("drain script: drains with the options from files and leaves the node cordoned", { skip: !hasTools }, () => {
  const out = runScript(DRAIN_SCRIPT);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.state.calls, [
    "drain node-2 --ignore-daemonsets=true --delete-emptydir-data=false --timeout=300s",
  ]);
  assert.equal(out.lines.at(-1), "node-2 is drained and stays cordoned; uncordon it to take pods again.");
});

test("drain script: a stuck drain names the budgets that allow no disruption", { skip: !hasTools }, () => {
  const out = runScript(DRAIN_SCRIPT, {
    drainFails: true,
    pdbs: [pdb("apps", "db", "db", 0), pdb("apps", "cache", "cache", 2)],
  });
  assert.equal(out.status, 1);
  assert.ok(out.lines.includes("PodDisruptionBudgets that allow no eviction right now:"));
  assert.ok(out.lines.includes("  apps/db"));
  assert.ok(!out.lines.includes("  apps/cache"));
  assert.match(out.lines.at(-1)!, /^Error: node-2 is cordoned but not drained/);
});

test("reboot script: drain, reboot pod, down, back with a new boot ID, uncordon", { skip: !hasTools }, () => {
  const out = runScript(REBOOT_SCRIPT);
  assert.equal(out.status, 0, `${out.lines.join("\n")}\n${out.stderr}`);
  const verbs = out.state.calls.map((c) => c.split(" ").slice(0, 2).join(" "));
  assert.deepEqual(verbs, [
    "get node",
    "drain node-2",
    "delete pod",
    "create -f",
    "get node",
    "get node",
    "delete pod",
    "uncordon node-2",
    "get node",
  ]);
  assert.equal(out.state.created?.spec && (out.state.created.spec as { nodeName: string }).nodeName, "node-2");
  assert.equal(out.state.bootID, "boot-a-2");
  assert.equal(out.state.unschedulable, false);
  assert.ok(out.lines.includes("node-2 went down."));
  assert.equal(out.lines.at(-1), "node-2 rebooted, is Ready and takes pods again.");
});

test(
  "reboot script: a failed reboot pod stops it with the pod's log; the node stays cordoned",
  { skip: !hasTools },
  () => {
    const out = runScript(REBOOT_SCRIPT, { rebootFails: true });
    assert.equal(out.status, 1);
    assert.ok(out.lines.includes("Failed to connect to bus"));
    assert.match(out.lines.at(-1)!, /^Error: the reboot command failed on node-2/);
    assert.equal(out.state.unschedulable, true);
  }
);

test("reboot script: a node that never comes back fails at the deadline, cordoned", { skip: !hasTools }, () => {
  const out = runScript(REBOOT_SCRIPT, { neverReturns: true }, { "reboot-wait": "0" });
  assert.equal(out.status, 1);
  assert.match(out.lines.at(-1)!, /^Error: node-2 did not come back Ready within 0 minutes; it stays cordoned\.$/);
  assert.equal(out.state.unschedulable, true);
  assert.ok(!out.state.calls.some((c) => c.startsWith("uncordon")));
});

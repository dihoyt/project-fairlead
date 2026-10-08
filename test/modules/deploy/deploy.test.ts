import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { DeployJobView, DeployPlan, DeployStatus } from "../../../src/contracts/deploy.js";
import type { Events } from "../../../src/contracts/events.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import type { LogLines } from "../../../src/contracts/workloads.js";
import { createMockCatalogService, mockDiscovery } from "../../../src/contracts/mocks/catalog.js";
import { createMockContext, mockAdmin, mockViewer, type MockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s, type FakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import type { K8sApi } from "../../../src/contracts/k8s.js";
import mod, { registerDeploy } from "../../../src/modules/deploy/index.js";
import { JOB_LABEL } from "../../../src/modules/deploy/job.js";
import { summarize, type Deployer } from "../../../src/modules/deploy/runner.js";
import { toYaml } from "../../../src/modules/deploy/yaml.js";
import { firstService } from "../../../src/modules/deploy/manifest.js";
import { mockCatalog } from "../../../src/contracts/mocks/catalog.js";
import type { CatalogEntry, DiscoveryReport } from "../../../src/contracts/catalog.js";
import { createRedactor } from "../../../src/modules/deploy/redact.js";
import { product } from "../../../src/product.js";
import { listen } from "../../runtime/helpers.js";

const NS = "console";
const IMAGE = "docker.io/alpine/k8s@sha256:1111111111111111111111111111111111111111111111111111111111111111";
const PASSWORD = "s3cret-Gitea-pass";

interface Env {
  mock: MockContext;
  k8s: FakeK8s;
  deployer: Deployer;
  server: { url: string; close(): Promise<void> };
  events: Array<Events["deploy.finished"]>;
}

let env: Env | undefined;

async function setup(
  options: {
    settings?: Record<string, unknown>;
    k8s?: FakeK8s;
    k8sService?: K8sApi;
    catalog?: ReturnType<typeof createMockCatalogService> | null;
    logs?: Record<string, string[]>;
  } = {}
): Promise<Env> {
  const k8s = options.k8s ?? createFakeK8s({ logs: options.logs });
  const mock = createMockContext("deploy", {
    migrations: mod.migrations,
    settings: { "deploy.image": IMAGE, "deploy.namespace": NS, "deploy.release": "console", ...options.settings },
    services: {
      k8s: options.k8sService ?? k8s,
      ...(options.catalog === null ? {} : { catalog: options.catalog ?? createMockCatalogService() }),
    },
  });
  let n = 0;
  const { deployer } = registerDeploy(mock.ctx, { now: () => MOCK_NOW, generate: () => `generated-secret-${++n}` });
  const events: Env["events"] = [];
  mock.ctx.bus.on("deploy.finished", (payload) => void events.push(payload));
  const server = await listen(mock.app);
  env = { mock, k8s, deployer, server, events };
  return env;
}

afterEach(async () => {
  if (!env) return;
  env.deployer.stop();
  await env.server.close();
  await env.mock.close();
  env = undefined;
});

async function call<T>(e: Env, method: "GET" | "POST", path: string, body?: unknown, expect = 200): Promise<T> {
  const url = `${e.server.url}/api/deploy${path}`;
  const res =
    method === "GET"
      ? await fetch(url)
      : await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
  const json = (await res.json()) as T;
  assert.equal(res.status, expect, JSON.stringify(json));
  return json;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function jobStatus(job: KubeObject, status: Record<string, unknown>): KubeObject {
  return { ...job, status };
}

function podFor(jobId: string, name: string): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace: NS, labels: { [JOB_LABEL]: jobId }, creationTimestamp: "2026-01-01T00:00:00Z" },
  };
}

// --- yaml ------------------------------------------------------------------

test("toYaml writes nested maps and lists and quotes what YAML would misread", () => {
  assert.equal(
    toYaml({
      ingress: {
        enabled: true,
        className: undefined,
        annotations: { "cert-manager.io/cluster-issuer": "letsencrypt-prod" },
        hosts: [{ host: "a.example.test", paths: [{ path: "/", type: "Prefix" }] }],
        tls: [],
      },
      args: ["--kubelet-insecure-tls"],
      tricky: ["yes", "10Gi", "a: b", "multi\nline", "*star", ""],
      empty: {},
    }),
    [
      "ingress:",
      "  enabled: true",
      "  annotations:",
      "    cert-manager.io/cluster-issuer: letsencrypt-prod",
      "  hosts:",
      "  - host: a.example.test",
      "    paths:",
      "    - path: /",
      "      type: Prefix",
      "  tls: []",
      "args:",
      '- "--kubelet-insecure-tls"',
      "tricky:",
      '- "yes"',
      '- "10Gi"',
      '- "a: b"',
      '- "multi\\nline"',
      '- "*star"',
      '- ""',
      "empty: {}",
      "",
    ].join("\n")
  );
});

test("the redactor masks plain and base64 values and cuts long lines after masking", () => {
  const redact = createRedactor([PASSWORD, "abc"]);
  assert.deepEqual(redact(`password=${PASSWORD}`), { line: "password=********", redacted: true });
  const b64 = Buffer.from(PASSWORD).toString("base64");
  assert.equal(redact(`auth ${b64}`).line, "auth ********");
  assert.deepEqual(redact("abc is too short to mask"), { line: "abc is too short to mask", redacted: false });
  const long = `${"x".repeat(16 * 1024 - 4)}${PASSWORD}`;
  assert.ok(!redact(long).line.includes(PASSWORD.slice(0, 4)));
});

test("summarize picks Helm's status, the error, or the dry-run line", () => {
  assert.equal(
    summarize(["NAME: gitea", "STATUS: deployed", "NOTES:", "hi"], "succeeded", "install", "gitea"),
    'Release "gitea" deployed.'
  );
  assert.equal(
    summarize(["x", "Error: UPGRADE FAILED: boom", "y"], "failed", "install", "gitea"),
    "Error: UPGRADE FAILED: boom"
  );
  assert.equal(summarize(["ok"], "succeeded", "dry-run", "gitea"), "Dry run passed: nothing was changed.");
});

// --- status ----------------------------------------------------------------

test("status: enabled with the image, writes and grants; defaults come from discovery", async () => {
  const e = await setup({ settings: { "deploy.storageClass": "local-path" } });
  const status = await call<DeployStatus>(e, "GET", "/status");
  assert.equal(status.enabled, true);
  assert.equal(status.enableHint, undefined);
  assert.equal(status.namespace, NS);
  assert.equal(status.image, IMAGE);
  assert.equal(status.installerServiceAccount, `${product.chartName}-installer`);
  assert.deepEqual(status.defaults, { ...mockDiscovery.suggested, storageClass: "local-path" });
});

test("status: off with the enable line when the grant, the image or the writes are missing", async () => {
  const denied = await setup({ k8s: createFakeK8s({ denied: ["create batch/jobs"] }) });
  const off = await call<DeployStatus>(denied, "GET", "/status");
  assert.equal(off.enabled, false);
  assert.equal(
    off.enableHint,
    `helm upgrade console oci://${product.imageRegistry}/charts/${product.chartName} -n ${NS} --reuse-values --set deploy.enabled=true`
  );
  await env!.server.close();
  await env!.mock.close();

  const noImage = await setup({ settings: { "deploy.image": "" } });
  assert.equal((await call<DeployStatus>(noImage, "GET", "/status")).enabled, false);
  await env!.server.close();
  await env!.mock.close();

  const fake = createFakeK8s();
  const readOnly: K8sApi = { ...fake, create: undefined, delete: undefined };
  const noWrites = await setup({ k8sService: readOnly });
  assert.equal((await call<DeployStatus>(noWrites, "GET", "/status")).enabled, false);
});

// --- plans -----------------------------------------------------------------

test("plan: headlamp gets a host under the base domain, TLS from the issuer, and the exact helm line", async () => {
  const e = await setup();
  const plan = await call<DeployPlan>(e, "POST", "/plan", { appId: "headlamp", inputs: {} });
  assert.equal(plan.allowed, true, plan.blockedBy);
  assert.deepEqual(plan.inputs, { host: "headlamp.example.test" });
  assert.equal(plan.url, "https://headlamp.example.test");
  assert.deepEqual(plan.commands, [
    "helm upgrade --install headlamp headlamp --repo https://kubernetes-sigs.github.io/headlamp " +
      "--version 0.0.0-mock --namespace headlamp --create-namespace --values /values/values.yaml --wait --timeout 10m",
  ]);
  assert.match(plan.values, /ingressClassName: traefik/);
  assert.match(plan.values, /cert-manager.io\/cluster-issuer: letsencrypt-prod/);
  assert.match(plan.values, /- host: headlamp.example.test/);
  assert.deepEqual(plan.creates, [
    { kind: "Namespace", name: "headlamp" },
    { kind: "Secret", name: "deploy-headlamp-values", namespace: NS },
    { kind: "Job", name: "deploy-headlamp-1", namespace: NS },
  ]);
  assert.deepEqual(e.k8s.writes, [], "a plan writes nothing");
});

test("plan: secrets are masked in inputs and values; OCI charts use the oci ref", async () => {
  const e = await setup();
  const plan = await call<DeployPlan>(e, "POST", "/plan", {
    appId: "gitea",
    inputs: { host: "git.example.test", adminPassword: PASSWORD },
  });
  assert.equal(plan.allowed, true, plan.blockedBy);
  assert.deepEqual(plan.inputs, { host: "git.example.test", adminUser: "gitea-admin", adminPassword: "********" });
  assert.ok(!JSON.stringify(plan).includes(PASSWORD));
  assert.match(plan.values, /password: "\*\*\*\*\*\*\*\*"/);
  assert.match(plan.commands[0]!, /^helm upgrade --install gitea oci:\/\/docker.gitea.com\/charts\/gitea --version /);
  assert.ok(!plan.commands[0]!.includes("--repo"));
});

test("plan: field errors, missing requirements, already installed, deploys off, unknown app", async () => {
  const noCertManager = {
    ...mockDiscovery,
    apps: mockDiscovery.apps.map((a) => (a.appId === "cert-manager" ? { ...a, state: "not-installed" as const } : a)),
  };
  const e = await setup({ catalog: createMockCatalogService({ discovery: noCertManager }) });

  const rancher = await call<DeployPlan>(e, "POST", "/plan", {
    appId: "rancher",
    inputs: { host: "Not A Host!", extra: "x" },
  });
  assert.equal(rancher.allowed, false);
  assert.equal(rancher.inputErrors.host, "must be a hostname like app.example.com");
  assert.equal(rancher.inputErrors.bootstrapPassword, "required");
  assert.equal(rancher.inputErrors.extra, "not an input of Rancher");
  assert.equal(rancher.blockedBy, "host: must be a hostname like app.example.com");
  assert.deepEqual(rancher.missingRequires, ["cert-manager"]);

  const valid = await call<DeployPlan>(e, "POST", "/plan", {
    appId: "rancher",
    inputs: { host: "rancher.example.test", bootstrapPassword: PASSWORD },
  });
  assert.equal(valid.blockedBy, "Needs cert-manager installed first.");

  const grafana = await call<DeployPlan>(e, "POST", "/plan", { appId: "grafana", inputs: { adminPassword: PASSWORD } });
  assert.match(grafana.blockedBy ?? "", /^Grafana is already installed \(Deployment monitoring\/grafana/);

  const target = await call<DeployPlan>(e, "POST", "/plan", {
    appId: "longhorn-backup-target",
    inputs: { target: "ftp://nope" },
  });
  assert.match(target.inputErrors.target ?? "", /nfs:\/\//);

  await call(e, "POST", "/plan", { appId: "nope", inputs: {} }, 404);
  await call(e, "POST", "/plan", { inputs: {} }, 400);
  e.mock.setUser(mockViewer);
  await call(e, "POST", "/plan", { appId: "headlamp", inputs: {} }, 403);
});

test("plan: blocked when deploys are off, 503 without a catalog", async () => {
  const off = await setup({ settings: { "deploy.image": "" } });
  const plan = await call<DeployPlan>(off, "POST", "/plan", { appId: "headlamp", inputs: {} });
  assert.equal(plan.allowed, false);
  assert.equal(plan.blockedBy, "Deploys are turned off for this install.");
  await env!.server.close();
  await env!.mock.close();

  const none = await setup({ catalog: null });
  await call(none, "POST", "/plan", { appId: "headlamp", inputs: {} }, 503);
});

test("plan: cert-manager's issuer step and a patch app's values", async () => {
  const e = await setup();
  const cm = await call<DeployPlan>(e, "POST", "/plan", {
    appId: "cert-manager",
    namespace: "certs",
    inputs: { acmeEmail: "ops@example.test" },
  });
  // Installed already per discovery, so it is blocked, but the preview is whole.
  assert.equal(cm.namespace, "certs");
  assert.equal(cm.commands.length, 2);
  assert.equal(cm.commands[1], "kubectl apply -f /values/issuer.yaml");
  assert.match(cm.values, /crds:\n {2}enabled: true/);

  const patch = await call<DeployPlan>(e, "POST", "/plan", {
    appId: "longhorn-backup-target",
    inputs: { target: "nfs://nas.example.test:/backups" },
  });
  assert.equal(patch.allowed, true, patch.blockedBy);
  assert.equal(patch.values, "spec:\n  backupTargetURL: nfs://nas.example.test:/backups\n");
  assert.deepEqual(patch.commands, [
    "kubectl patch backuptargets.longhorn.io default --namespace longhorn-system --type merge --patch-file /values/patch.yaml",
  ]);
  assert.deepEqual(
    patch.creates.map((c) => c.kind),
    ["Secret", "Job"]
  );
});

// --- jobs ------------------------------------------------------------------

async function startGitea(e: Env, mode: "install" | "dry-run" = "install"): Promise<DeployJobView> {
  return call<DeployJobView>(e, "POST", "/jobs", {
    appId: "gitea",
    mode,
    inputs: { host: "git.example.test", adminPassword: PASSWORD },
  });
}

test("start: creates the Job and its values Secret, audits, and refuses a second run", async () => {
  const e = await setup();
  const view = await startGitea(e);
  assert.equal(view.id, "dj_1");
  assert.equal(view.state, "pending");
  assert.equal(view.url, "https://git.example.test");
  assert.deepEqual(view.job, { namespace: NS, name: "deploy-gitea-1" });

  assert.deepEqual(
    e.k8s.writes.map((w) => `${w.verb} ${w.ref.plural} ${w.namespace}/${w.name}`),
    [
      `delete secrets ${NS}/deploy-gitea-values`,
      `create jobs ${NS}/deploy-gitea-1`,
      `create secrets ${NS}/deploy-gitea-values`,
    ]
  );

  const job = (await e.k8s.get(RESOURCES.jobs, "deploy-gitea-1", NS)) as KubeObject & {
    spec: {
      backoffLimit: number;
      ttlSecondsAfterFinished: number;
      activeDeadlineSeconds: number;
      template: {
        metadata: { labels: Record<string, string> };
        spec: {
          serviceAccountName: string;
          containers: Array<{ image: string; command: string[]; securityContext: Record<string, unknown> }>;
        };
      };
    };
  };
  assert.equal(job.metadata.labels?.["app.kubernetes.io/managed-by"], product.ownerMarker.labelDomain);
  assert.equal(job.metadata.labels?.[JOB_LABEL], "dj_1");
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.ttlSecondsAfterFinished, 86_400);
  assert.equal(job.spec.activeDeadlineSeconds, 900);
  assert.equal(job.spec.template.metadata.labels[JOB_LABEL], "dj_1");
  const pod = job.spec.template.spec;
  assert.equal(pod.serviceAccountName, `${product.chartName}-installer`);
  const [container] = pod.containers;
  assert.equal(container!.image, IMAGE);
  assert.equal(container!.securityContext.readOnlyRootFilesystem, true);
  const script = container!.command[2]!;
  assert.match(script, /'helm' 'upgrade' '--install' 'gitea' 'oci:\/\/docker.gitea.com\/charts\/gitea'/);
  assert.ok(!script.includes(PASSWORD), "inputs never reach the command line");
  assert.ok(!script.includes("git.example.test"), "inputs never reach the command line");

  const secret = (await e.k8s.get(RESOURCES.secrets, "deploy-gitea-values", NS)) as KubeObject & {
    stringData: Record<string, string>;
  };
  assert.match(secret.stringData["values.yaml"]!, new RegExp(`password: ${PASSWORD}`));
  assert.equal(secret.metadata.ownerReferences?.[0]?.name, "deploy-gitea-1");
  assert.equal(secret.metadata.ownerReferences?.[0]?.uid, job.metadata.uid);

  assert.deepEqual(e.mock.audit.at(-1), {
    actor: "admin",
    action: "deploy.start",
    target: "dj_1",
    detail: `gitea 0.0.0-mock install into gitea (Job ${NS}/deploy-gitea-1)`,
  });
  assert.ok(!JSON.stringify(e.mock.audit).includes(PASSWORD));

  const busy = await call<{ error: string }>(
    e,
    "POST",
    "/jobs",
    { appId: "gitea", mode: "install", inputs: { host: "git.example.test", adminPassword: PASSWORD } },
    409
  );
  assert.match(busy.error, /dj_1/);
  await call(e, "POST", "/jobs", { appId: "gitea", mode: "upgrade", inputs: {} }, 400);
  await call(e, "POST", "/jobs", { appId: "rancher", mode: "install", inputs: {} }, 400);
});

test("a dry run renders server-side without waiting and skips steps that need the install", async () => {
  const e = await setup({
    catalog: createMockCatalogService({
      discovery: {
        ...mockDiscovery,
        apps: mockDiscovery.apps.map((a) =>
          a.appId === "cert-manager" ? { ...a, state: "not-installed" as const } : a
        ),
      },
    }),
  });
  const view = await call<DeployJobView>(e, "POST", "/jobs", {
    appId: "cert-manager",
    mode: "dry-run",
    inputs: { acmeEmail: "ops@example.test" },
  });
  assert.equal(view.url, undefined);
  const job = (await e.k8s.get(RESOURCES.jobs, view.job.name, NS)) as KubeObject & {
    spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
  };
  const script = job.spec.template.spec.containers[0]!.command[2]!;
  assert.match(script, /'--dry-run=server'/);
  assert.ok(!script.includes("'--wait'"));
  assert.ok(!script.includes("issuer.yaml"));

  const plan = await call<DeployPlan>(e, "POST", "/plan", { appId: "cert-manager", inputs: {} });
  assert.ok(plan.warnings.some((w) => /no Let's Encrypt issuer/.test(w)));
});

test("the watch finishes a job: state, message from Helm, redacted log kept, event emitted", async () => {
  const e = await setup({
    logs: {
      [`${NS}/deploy-gitea-1-x7k2p`]: [
        'Release "gitea" does not exist. Installing it now.',
        `debug: admin password is ${PASSWORD}`,
        "NAME: gitea",
        "STATUS: deployed",
      ],
    },
  });
  await startGitea(e);
  await e.deployer.ensureWatch();
  const job = (await e.k8s.get(RESOURCES.jobs, "deploy-gitea-1", NS)) as KubeObject;

  e.k8s.upsert(RESOURCES.jobs, jobStatus(job, { startTime: "2026-01-01T00:00:01Z", active: 1 }));
  await settle();
  assert.equal((await call<DeployJobView>(e, "GET", "/jobs/dj_1")).state, "running");

  e.k8s.upsert(RESOURCES.pods, podFor("dj_1", "deploy-gitea-1-x7k2p"));
  const live = await call<LogLines>(e, "GET", "/jobs/dj_1/logs");
  assert.equal(live.redacted, 1);
  assert.equal(live.lines[1], "debug: admin password is ********");

  e.k8s.upsert(
    RESOURCES.jobs,
    jobStatus(job, {
      startTime: "2026-01-01T00:00:01Z",
      conditions: [{ type: "Complete", status: "True" }],
    })
  );
  await settle();
  const done = await call<DeployJobView>(e, "GET", "/jobs/dj_1");
  assert.equal(done.state, "succeeded");
  assert.equal(done.message, 'Release "gitea" deployed.');
  assert.ok(done.finishedAt);
  assert.deepEqual(e.events, [
    { jobId: "dj_1", appId: "gitea", mode: "install", state: "succeeded", url: "https://git.example.test" },
  ]);
  assert.equal(e.mock.secrets.size, 0, "the redaction values go once the log is kept");

  // Pod gone with the Job's TTL: the stored log answers.
  e.k8s.remove(RESOURCES.pods, "deploy-gitea-1-x7k2p", NS);
  const kept = await call<LogLines>(e, "GET", "/jobs/dj_1/logs?tail=2");
  assert.deepEqual(kept, { lines: ["NAME: gitea", "STATUS: deployed"], redacted: 1, truncated: true });

  const res = await fetch(`${e.server.url}/api/deploy/jobs/dj_1/logs/stream`);
  assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
  const body = await res.text();
  assert.ok(body.includes('data: {"line":"debug: admin password is ********"}'));
  assert.ok(!body.includes(PASSWORD));

  // A second final event (the other pod's watch) changes nothing.
  e.k8s.upsert(RESOURCES.jobs, jobStatus(job, { conditions: [{ type: "Failed", status: "True" }] }));
  await settle();
  assert.equal((await call<DeployJobView>(e, "GET", "/jobs/dj_1")).state, "succeeded");
  assert.equal(e.events.length, 1);
});

test("a deadline failure without a pod says so", async () => {
  const e = await setup();
  await startGitea(e);
  await e.deployer.ensureWatch();
  const job = (await e.k8s.get(RESOURCES.jobs, "deploy-gitea-1", NS)) as KubeObject;
  e.k8s.upsert(
    RESOURCES.jobs,
    jobStatus(job, { conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded" }] })
  );
  await settle();
  const view = await call<DeployJobView>(e, "GET", "/jobs/dj_1");
  assert.equal(view.state, "failed");
  assert.equal(view.message, "Stopped after 15 minutes without finishing.");
  assert.deepEqual(
    e.events.map((ev) => ev.state),
    ["failed"]
  );
  assert.equal(e.events[0]!.url, undefined);
});

test("a Job deleted out from under a deploy fails it after two reconcile passes", async () => {
  const e = await setup();
  await startGitea(e);
  await e.deployer.ensureWatch();
  e.k8s.remove(RESOURCES.jobs, "deploy-gitea-1", NS);
  await e.deployer.reconcile();
  assert.equal((await call<DeployJobView>(e, "GET", "/jobs/dj_1")).state, "pending");
  await e.deployer.reconcile();
  const view = await call<DeployJobView>(e, "GET", "/jobs/dj_1");
  assert.equal(view.state, "failed");
  assert.equal(view.message, "The Job was deleted before it finished.");
});

test("cancel deletes the Job, keeps the log, audits, and refuses a finished job", async () => {
  const e = await setup({ logs: { [`${NS}/deploy-gitea-1-abc`]: ["Installing", `pw ${PASSWORD}`] } });
  await startGitea(e);
  e.k8s.upsert(RESOURCES.pods, podFor("dj_1", "deploy-gitea-1-abc"));
  e.mock.setUser(mockViewer);
  await call(e, "POST", "/jobs/dj_1/cancel", undefined, 403);
  e.mock.setUser(mockAdmin);

  const view = await call<DeployJobView>(e, "POST", "/jobs/dj_1/cancel");
  assert.equal(view.state, "cancelled");
  assert.equal(view.message, "Cancelled by admin.");
  assert.equal(e.k8s.writes.at(-1)?.verb, "delete");
  assert.equal(e.k8s.writes.at(-1)?.ref.plural, "jobs");
  assert.deepEqual((await call<LogLines>(e, "GET", "/jobs/dj_1/logs")).lines, ["Installing", "pw ********"]);
  assert.equal(e.mock.audit.at(-1)?.action, "deploy.cancel");
  assert.deepEqual(
    e.events.map((ev) => ev.state),
    ["cancelled"]
  );
  await call(e, "POST", "/jobs/dj_1/cancel", undefined, 409);

  // The release is free again.
  assert.equal((await startGitea(e)).id, "dj_2");
});

test("a Job the API refuses fails the deploy with the reason", async () => {
  const e = await setup({ k8s: createFakeK8s({ denied: ["create batch/jobs"] }) });
  // Enabled-ness is checked through can(), which the fake denies the same way,
  // so allow it for this test and let create() fail.
  e.k8s.can = async () => true;
  const res = await call<{ error: string }>(
    e,
    "POST",
    "/jobs",
    { appId: "headlamp", mode: "install", inputs: {} },
    502
  );
  assert.match(res.error, /^Could not start the Job: fake k8s: forbidden/);
  const [view] = await call<DeployJobView[]>(e, "GET", "/jobs");
  assert.equal(view!.state, "failed");
  assert.equal(e.mock.audit.at(-1)?.result, "error");
});

test("jobs list newest first, by app, limited; unknown ids 404", async () => {
  const e = await setup();
  await call(e, "POST", "/jobs", { appId: "headlamp", mode: "dry-run", inputs: {} });
  await startGitea(e);
  assert.deepEqual(
    (await call<DeployJobView[]>(e, "GET", "/jobs")).map((j) => j.id),
    ["dj_2", "dj_1"]
  );
  assert.deepEqual(
    (await call<DeployJobView[]>(e, "GET", "/jobs?appId=headlamp")).map((j) => j.id),
    ["dj_1"]
  );
  assert.equal((await call<DeployJobView[]>(e, "GET", "/jobs?limit=1")).length, 1);
  await call(e, "GET", "/jobs?limit=0", undefined, 400);
  await call(e, "GET", "/jobs/dj_9", undefined, 404);
  await call(e, "GET", "/jobs/dj_9/logs", undefined, 404);
  e.mock.setUser(mockViewer);
  assert.equal((await call<DeployJobView[]>(e, "GET", "/jobs")).length, 2, "anyone signed in can read jobs");
});

// --- manifests -------------------------------------------------------------

const NTFY_MANIFEST = [
  "apiVersion: v1",
  "kind: Namespace",
  "metadata:",
  "  name: ntfy",
  "---",
  "apiVersion: apps/v1",
  "kind: Deployment",
  "metadata:",
  "  name: ntfy",
  "  namespace: ntfy",
  "spec:",
  "  template:",
  "    spec:",
  "      containers:",
  "        - name: ntfy",
  "          ports:",
  "            - name: http",
  "              containerPort: 80",
  "---",
  "apiVersion: v1",
  "kind: Service",
  "metadata:",
  "  name: ntfy-web",
  "  namespace: ntfy",
  "  labels:",
  "    name: not-this",
  "spec:",
  "  ports:",
  "    - name: http",
  "      port: 8080",
  "      targetPort: http",
  "",
].join("\n");

const withNtfy = (bundled: string): CatalogEntry[] =>
  mockCatalog.map((entry) =>
    entry.id === "ntfy" ? { ...entry, install: { kind: "manifest", bundled, version: "v0.0.0-mock" } } : entry
  );

test("firstService reads the Service's own name, namespace and first port", () => {
  assert.deepEqual(firstService(NTFY_MANIFEST), { name: "ntfy-web", namespace: "ntfy", port: 8080 });
  assert.equal(firstService("kind: Deployment\nmetadata:\n  name: x\n"), undefined);
});

test("a bundled manifest is applied from the values Secret with an Ingress for its host", async () => {
  const e = await setup({ catalog: createMockCatalogService({ entries: withNtfy(NTFY_MANIFEST) }) });
  const plan = await call<DeployPlan>(e, "POST", "/plan", { appId: "ntfy", inputs: {} });
  assert.equal(plan.allowed, true, plan.blockedBy);
  assert.equal(plan.url, "https://ntfy.example.test");
  assert.deepEqual(plan.commands, ["kubectl apply -f /values/manifest.yaml", "kubectl apply -f /values/ingress.yaml"]);
  assert.match(plan.values, /kind: Ingress/);
  assert.match(plan.values, /name: ntfy-web\n\s+port:\n\s+number: 8080/);
  assert.deepEqual(
    plan.creates.map((c) => c.kind),
    ["Secret", "Job"]
  );

  const moved = await call<DeployPlan>(e, "POST", "/plan", { appId: "ntfy", namespace: "elsewhere", inputs: {} });
  assert.equal(moved.inputErrors.namespace, "ntfy installs into ntfy");

  const view = await call<DeployJobView>(e, "POST", "/jobs", { appId: "ntfy", mode: "dry-run", inputs: {} });
  const secret = (await e.k8s.get(RESOURCES.secrets, "deploy-ntfy-values", NS)) as KubeObject & {
    stringData: Record<string, string>;
  };
  assert.equal(secret.stringData["manifest.yaml"], NTFY_MANIFEST);
  assert.match(secret.stringData["ingress.yaml"]!, /host: ntfy.example.test/);
  const job = (await e.k8s.get(RESOURCES.jobs, view.job.name, NS)) as KubeObject & {
    spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
  };
  const script = job.spec.template.spec.containers[0]!.command[2]!;
  assert.match(script, /'kubectl' 'apply' '-f' '\/values\/manifest.yaml' '--dry-run=client'/);
  assert.match(script, /'kubectl' 'apply' '-f' '\/values\/ingress.yaml' '--dry-run=client'/);
});

test("a bundled manifest with no Service for its host is blocked; a URL manifest applies the URL", async () => {
  const e = await setup({
    catalog: createMockCatalogService({ entries: withNtfy("kind: ConfigMap\nmetadata:\n  name: x\n") }),
  });
  const plan = await call<DeployPlan>(e, "POST", "/plan", { appId: "ntfy", inputs: {} });
  assert.equal(plan.blockedBy, "The bundled manifest for ntfy has no Service for its hostname.");

  const lpp = await call<DeployPlan>(e, "POST", "/plan", { appId: "local-path-provisioner", inputs: {} });
  assert.equal(lpp.allowed, true, lpp.blockedBy);
  assert.equal(lpp.commands.length, 2);
  assert.match(
    lpp.commands[0]!,
    /^kubectl apply -f https:\/\/raw.githubusercontent.com\/rancher\/local-path-provisioner\//
  );
  assert.match(lpp.commands[1]!, /^kubectl patch storageclass local-path --type merge -p /);
  assert.ok(
    lpp.warnings.some((w) => /two/.test(w)),
    "the cluster already has a default"
  );
});

// --- for discovery ---------------------------------------------------------

test("releases() lists the latest install job per release; values and Ingresses carry the deployed-by label", async () => {
  const e = await setup({ catalog: createMockCatalogService({ entries: withNtfy(NTFY_MANIFEST) }) });
  await call(e, "POST", "/jobs", { appId: "headlamp", mode: "dry-run", inputs: {} });
  assert.deepEqual(await e.mock.ctx.services.get("deploy").releases(), [], "dry runs are not releases");
  await startGitea(e);
  await call(e, "POST", "/jobs/dj_2/cancel");
  await startGitea(e);
  assert.deepEqual(await e.mock.ctx.services.get("deploy").releases(), [
    { appId: "gitea", release: "gitea", namespace: "gitea", jobId: "dj_3", state: "pending" },
  ]);

  const key = `${product.ownerMarker.labelDomain}/deployed-by`;
  const traefik = await call<DeployPlan>(e, "POST", "/plan", { appId: "traefik", inputs: {} });
  assert.match(traefik.values, new RegExp(`commonLabels:\\n  ${key}: deploy`));
  const ntfy = await call<DeployPlan>(e, "POST", "/plan", { appId: "ntfy", inputs: {} });
  assert.match(ntfy.values, new RegExp(`labels:\\n    ${key}: deploy`));
});

test("plan: a chart's kubeVersion picks the newest pin the cluster fits, or blocks", async () => {
  const notInstalled = { ...mockDiscovery, apps: mockDiscovery.apps.filter((app) => app.appId !== "longhorn") };
  const request = { appId: "longhorn", inputs: { host: "longhorn.example.test" } };

  let e = await setup({ catalog: createMockCatalogService({ discovery: notInstalled }) });
  let plan = await call<DeployPlan>(e, "POST", "/plan", request);
  assert.equal(plan.allowed, true, plan.blockedBy);
  assert.equal(plan.version, "1.98.0-mock");
  assert.match(plan.commands[0]!, / --version 1\.98\.0-mock /);
  assert.ok(
    plan.warnings.includes(
      "Installs Longhorn 1.98.0-mock, the newest version that supports Kubernetes v1.31.4+k3s1; 1.99.0-mock needs >=1.99.0-0."
    ),
    JSON.stringify(plan.warnings)
  );
  await env!.server.close();
  env!.deployer.stop();
  await env!.mock.close();
  env = undefined;

  e = await setup({
    catalog: createMockCatalogService({ discovery: { ...notInstalled, kubernetesVersion: "v1.20.3" } }),
  });
  plan = await call<DeployPlan>(e, "POST", "/plan", request);
  assert.equal(plan.allowed, false);
  assert.match(plan.blockedBy ?? "", /^Longhorn: Needs Kubernetes .*this cluster runs v1\.20\.3\.$/);
  await env!.server.close();
  env!.deployer.stop();
  await env!.mock.close();
  env = undefined;

  // Without a version from discovery, the API server's is used.
  const { kubernetesVersion: _unknown, ...noVersion } = notInstalled;
  e = await setup({
    catalog: createMockCatalogService({ discovery: noVersion }),
    k8s: createFakeK8s({ version: { major: "1", minor: "20", gitVersion: "v1.20.3" } }),
  });
  plan = await call<DeployPlan>(e, "POST", "/plan", request);
  assert.match(plan.blockedBy ?? "", /this cluster runs v1\.20\.3\.$/);
});

test("plan: Longhorn's replica count follows the schedulable node count", async () => {
  const notInstalled = { ...mockDiscovery, apps: mockDiscovery.apps.filter((app) => app.appId !== "longhorn") };
  const request = { appId: "longhorn", inputs: { host: "longhorn.example.test" } };
  const single = "1 replica on a single node; raise it in Longhorn when you add nodes.";
  const GiB = 1024 ** 3;
  const cases: Array<[DiscoveryReport, number]> = [
    [{ ...notInstalled, nodeDisks: [{ node: "n1", availableBytes: 20 * GiB, capacityBytes: 30 * GiB }] }, 1],
    [notInstalled, 2],
    [{ ...notInstalled, nodeDisks: ["a", "b", "c", "d"].map((node) => ({ node, error: "timed out" })) }, 3],
    [{ ...notInstalled, nodeDisks: undefined }, 3],
  ];
  for (const [discovery, replicas] of cases) {
    const e = await setup({ catalog: createMockCatalogService({ discovery }) });
    const plan = await call<DeployPlan>(e, "POST", "/plan", request);
    assert.match(plan.values, new RegExp(`defaultReplicaCount: ${replicas}\\n`));
    assert.match(plan.values, new RegExp(`defaultClassReplicaCount: ${replicas}\\n`));
    assert.equal(plan.warnings.includes(single), replicas === 1, JSON.stringify(plan.warnings));
    if (replicas === 2) assert.ok(plan.warnings.some((w) => w.startsWith("2 replicas on 2 nodes")));
    await env!.server.close();
    env!.deployer.stop();
    await env!.mock.close();
    env = undefined;
  }
});

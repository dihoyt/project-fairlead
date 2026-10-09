import type { Response } from "express";
import type { CatalogEntry, CatalogService, DiscoveryReport } from "../../contracts/catalog.js";
import type {
  AccessRequest,
  AccessView,
  DeployActionKind,
  DeployActionRequest,
  DeployJobRequest,
  DeployJobState,
  DeployJobView,
  DeployJobMode,
  UpgradeReport,
  DeployMode,
  DeployPlan,
  DeployRequest,
  DeployStatus,
  DeployedRelease,
  GateStatus,
} from "../../contracts/deploy.js";
import { RESOURCES, type K8sApi, type KubeObject, type Watch } from "../../contracts/k8s.js";
import type { ModuleContext } from "../../contracts/module.js";
import type { LogLines } from "../../contracts/workloads.js";
import { HttpError } from "../../runtime/http.js";
import { errorMessage } from "../../runtime/log.js";
import { POSTGRES_APP, POSTGRES_NAMESPACE, pgClusterName, pgName } from "../../contracts/postgres.js";
import { product } from "../../product.js";
import { type GateActionContext } from "./actions/gate.js";
import { createConsoleDatabase } from "./actions/console-backup.js";
import {
  actionRecipe,
  type ActionContext,
  type ActionRecipe,
  type ActionRendered,
  type ConsoleDatabase,
} from "./actions/index.js";
import { currentCluster, type SharedPostgres } from "./actions/pg-objects.js";
import type { Defaults, Step } from "./apps.js";
import { accessView, AccessStore, resolves as lookupHost, type Resolver } from "./access.js";
import { enableHint, type DeployConfig } from "./config.js";
import {
  annotateSteps,
  appIngresses,
  applyMiddlewareStep,
  decide,
  gateStatus,
  GateStore,
  gateManifests,
  hostOf,
  publishesConsole,
  MIDDLEWARE_FILE,
  type GateInput,
} from "./gate.js";
import { CONTAINER, DEADLINE_SECONDS, JOB_LABEL, jobManifest, valuesSecret, type PodExtras } from "./job.js";
import { jobName, render, valuesSecretName, type Rendered } from "./plan.js";
import { createRedactor, type Redactor } from "./redact.js";
import { isFinal, type JobRecord, type Store } from "./store.js";
import { upgradeReport, upgradeSteps } from "./upgrades.js";

// The recipe for a TLS-only Ingress beside an app's own (Direct exposure).
const DIRECT_TLS = "direct-tls";

export const LOG_LINES = 500;
export const MAX_TAIL = 5000;
// A Job missing on this many reconcile passes in a row is gone, not lagging.
const MISSING_PASSES = 2;
const POD_WAIT_MS = 60_000;
const POD_POLL_MS = 2_000;
const HEARTBEAT_MS = 25_000;

const WITHHELD =
  "Log withheld: this pod cannot read the deploy's secret values to mask them (SECRETS_KEY is not set). " +
  "The pod that started the deploy shows it.";

interface JobStatus {
  conditions?: Array<{
    type?: string;
    status?: string;
    reason?: string;
    message?: string;
    lastTransitionTime?: string;
  }>;
  startTime?: string;
  completionTime?: string;
  active?: number;
}

interface Observed {
  state: Exclude<DeployJobState, "cancelled">;
  startedAt?: string;
  message?: string;
}

const deadlineOf = (job: KubeObject): number => {
  const set = (job.spec as { activeDeadlineSeconds?: unknown } | undefined)?.activeDeadlineSeconds;
  return typeof set === "number" && set > 0 ? set : DEADLINE_SECONDS;
};

export function observe(job: KubeObject): Observed {
  const status = (job.status ?? {}) as JobStatus;
  const condition = (type: string) => status.conditions?.find((c) => c.type === type && c.status === "True");
  if (condition("Complete")) return { state: "succeeded", startedAt: status.startTime };
  const failed = condition("Failed");
  if (failed) {
    return {
      state: "failed",
      startedAt: status.startTime,
      message:
        failed.reason === "DeadlineExceeded"
          ? `Stopped after ${Math.round(deadlineOf(job) / 60)} minutes without finishing.`
          : failed.message || failed.reason || "The Job failed.",
    };
  }
  if (status.startTime || (status.active ?? 0) > 0) return { state: "running", startedAt: status.startTime };
  return { state: "pending" };
}

// The line a user reads in the job list: Helm's STATUS, or the error.
export function summarize(lines: readonly string[], state: DeployJobState, mode: DeployJobMode, release: string) {
  const text = lines.map((line) => line.trim()).filter(Boolean);
  if (state === "succeeded") {
    if (mode === "dry-run") return "Dry run passed: nothing was changed.";
    // An action's script ends by echoing its result.
    if (mode === "action") return text.at(-1);
    const status = text.findLast((line) => line.startsWith("STATUS:"));
    if (status) return `Release "${release}" ${status.slice("STATUS:".length).trim()}.`;
    return text.at(-1);
  }
  if (state === "failed") return text.findLast((line) => /error/i.test(line));
  return undefined;
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { statusCode?: unknown; code?: unknown }).statusCode ?? (err as { code?: unknown }).code;
  return typeof status === "number" ? status : undefined;
}

export interface Found {
  discovery?: DiscoveryReport;
  error?: string;
}

// What a bundle step's plan is made with beyond a single deploy's.
export interface RenderContext {
  enabled?: boolean;
  found?: Found;
  refresh?: boolean;
  // Shared bundle answers and what earlier steps will have put in place.
  defaults?: Defaults;
  installedBefore?: readonly string[];
}

export interface DeployerOptions {
  // DNS lookups for the Access view, for tests.
  resolve?: Resolver;
  now?: () => number;
  // Overrides the random secrets a run generates, for tests.
  generate?: () => string;
  // Requests to a volume backup pod, for tests.
  fetch?: typeof fetch;
  // Replaces the console's own database (a file on its volume), for tests.
  consoleDatabase?: ConsoleDatabase;
}

export class Deployer {
  private readonly now: () => number;
  private readonly secretsInMemory = new Map<string, string[]>();
  private readonly missing = new Map<string, number>();
  private watch: Watch<KubeObject> | undefined;
  private watching: Promise<void> | undefined;

  private readonly ctx: ModuleContext;
  private readonly store: Store;
  private readonly config: DeployConfig;
  private readonly options: DeployerOptions;
  readonly access: AccessStore;
  readonly gates: GateStore;
  private readonly consoleDatabase: ConsoleDatabase | undefined;

  constructor(ctx: ModuleContext, store: Store, config: DeployConfig, options: DeployerOptions = {}) {
    this.ctx = ctx;
    this.store = store;
    this.config = config;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.access = new AccessStore(ctx.db, ctx.orgId);
    this.gates = new GateStore(ctx.db, ctx.orgId);
    this.consoleDatabase = options.consoleDatabase ?? createConsoleDatabase(ctx.db, config);
  }

  private iso() {
    return new Date(this.now()).toISOString();
  }

  private k8s(): K8sApi | undefined {
    return this.ctx.services.has("k8s") ? this.ctx.services.get("k8s") : undefined;
  }

  private catalog(): CatalogService {
    if (!this.ctx.services.has("catalog")) throw new HttpError(503, "The app catalog is not available.");
    return this.ctx.services.get("catalog");
  }

  // --- status and plans ----------------------------------------------------

  async enabled(): Promise<boolean> {
    const k8s = this.k8s();
    if (!k8s || !this.config.image() || typeof k8s.create !== "function" || typeof k8s.delete !== "function") {
      return false;
    }
    const namespace = this.config.namespace();
    try {
      const [jobs, secrets] = await Promise.all([
        k8s.can({ verb: "create", group: "batch", resource: "jobs", namespace }),
        k8s.can({ verb: "create", group: "", resource: "secrets", namespace }),
      ]);
      return jobs && secrets;
    } catch (err) {
      this.ctx.log.warn("Could not check deploy permissions", { error: errorMessage(err) });
      return false;
    }
  }

  async discover(refresh = false): Promise<Found> {
    if (!this.ctx.services.has("catalog")) return { error: "the app catalog is not available" };
    let discovery: DiscoveryReport;
    try {
      discovery = await this.ctx.services.get("catalog").discover(refresh);
    } catch (err) {
      return { error: errorMessage(err) };
    }
    // The plan checks each chart's kubeVersion against this; ask the API
    // server when discovery couldn't say.
    if (!discovery.kubernetesVersion && this.ctx.services.has("k8s")) {
      try {
        discovery = { ...discovery, kubernetesVersion: (await this.ctx.services.get("k8s").version()).gitVersion };
      } catch {
        // Unknown: the plan uses the pinned version unchecked.
      }
    }
    return { discovery };
  }

  private effectiveDefaults(discovery: DiscoveryReport | undefined): Defaults {
    const set = this.config.defaults();
    const found = discovery?.suggested ?? {};
    const access = this.access.get();
    return {
      // The Access step is the latest explicit choice of domain.
      baseDomain: access?.baseDomain || (set.baseDomain ?? found.baseDomain),
      ...(access ? { access: access.mode } : {}),
      ingressClass: set.ingressClass ?? found.ingressClass,
      clusterIssuer: set.clusterIssuer ?? found.clusterIssuer,
      storageClass: set.storageClass ?? found.storageClass,
    };
  }

  async status(): Promise<DeployStatus> {
    const [enabled, { discovery }] = await Promise.all([this.enabled(), this.discover()]);
    const defaults = this.effectiveDefaults(discovery);
    return {
      enabled,
      ...(enabled ? {} : { enableHint: enableHint(this.config) }),
      namespace: this.config.namespace(),
      installerServiceAccount: this.config.serviceAccount(),
      image: this.config.image(),
      defaults: Object.fromEntries(Object.entries(defaults).filter(([key, v]) => v !== undefined && key !== "access")),
    };
  }

  private async namespaceExists(name: string): Promise<boolean | undefined> {
    try {
      const found = await this.k8s()?.get(RESOURCES.namespaces, name);
      return found === undefined || found === "absent" ? undefined : found !== null;
    } catch {
      return undefined;
    }
  }

  // Template instances (Services.templates) after the catalog's own apps.
  private entries(): CatalogEntry[] {
    const templates = this.ctx.services.has("templates") ? this.ctx.services.get("templates").entries() : [];
    return [...this.catalog().entries(), ...templates];
  }

  async rendered(
    request: DeployRequest,
    mode: DeployMode,
    context: RenderContext = {},
    given?: CatalogEntry
  ): Promise<Rendered> {
    const entry = given ?? this.catalog().get(request.appId);
    if (!entry) throw new HttpError(404, `No app "${request.appId}" in the catalog.`);
    if (entry.id !== request.appId) throw new HttpError(400, `appId must be ${entry.id}.`);
    const [enabled, found] = await Promise.all([
      context.enabled ?? this.enabled(),
      context.found ?? this.discover(context.refresh),
    ]);
    const namespace = request.namespace?.trim() || entry.namespace;
    const defaults = this.effectiveDefaults(found.discovery);
    const gateInput = await this.gateInput(found.discovery, defaults);
    const ownerId =
      entry.id === DIRECT_TLS
        ? found.discovery?.ingressHosts.find((h) => h.host === request.inputs?.domain)?.appId
        : undefined;
    const owner = ownerId ? this.entries().find((e) => e.id === ownerId) : undefined;
    const gate =
      gateInput && (entry.id !== DIRECT_TLS || owner)
        ? {
            gate: {
              ...gateInput,
              isPublic: (owner ? undefined : request.public) ?? this.gates.isPublic((owner ?? entry).id),
              ...(owner ? { owner } : {}),
            },
          }
        : {};
    for (const [key, value] of Object.entries(context.defaults ?? {})) {
      if (value) defaults[key as keyof Defaults] = value;
    }
    return render(
      {
        entry,
        request,
        enabled,
        installedBefore: context.installedBefore,
        defaults,
        discovery: found.discovery,
        discoveryError: found.error,
        namespaceExists: await this.namespaceExists(namespace),
        postgres:
          entry.database === "postgres" || entry.id === POSTGRES_APP
            ? await this.sharedPostgres(entry, found.discovery, context.installedBefore)
            : undefined,
        jobNamespace: this.config.namespace(),
        jobName: jobName(entry.id, this.store.nextSeq()),
        valuesSecret: valuesSecretName(entry.id),
        ...gate,
      },
      mode,
      this.options.generate
    );
  }

  // The shared Postgres an app uses: the cluster the apps use now, or the
  // one an earlier step of the same bundle makes. The shared cluster itself
  // keeps the name it has. An app already installed with its own Postgres
  // keeps it: moving its data over is not something a re-install does.
  private async sharedPostgres(
    entry: CatalogEntry,
    discovery: DiscoveryReport | undefined,
    installedBefore: readonly string[] | undefined
  ): Promise<SharedPostgres | undefined> {
    const self = discovery?.apps.find((app) => app.appId === entry.id);
    if (entry.id !== POSTGRES_APP && self?.state === "installed" && !(await this.onSharedPostgres(entry))) {
      return undefined;
    }
    const k8s = this.k8s();
    let cluster: Awaited<ReturnType<typeof currentCluster>> | undefined;
    try {
      cluster = k8s ? await currentCluster(k8s) : undefined;
    } catch (err) {
      this.ctx.log.warn("Could not look for the shared Postgres", { error: errorMessage(err) });
    }
    if (cluster && cluster !== "absent") {
      return { namespace: cluster.metadata.namespace ?? POSTGRES_NAMESPACE, cluster: cluster.metadata.name };
    }
    if (entry.id === POSTGRES_APP || installedBefore?.includes(POSTGRES_APP)) {
      return { namespace: POSTGRES_NAMESPACE, cluster: pgClusterName(product.slug) };
    }
    return undefined;
  }

  // Whether an installed app already reads its connection from the shared
  // Postgres (its connection Secret exists).
  private async onSharedPostgres(entry: CatalogEntry): Promise<boolean> {
    const k8s = this.k8s();
    if (!k8s) return false;
    try {
      const listed = await k8s.list(RESOURCES.cnpgDatabases, { namespace: POSTGRES_NAMESPACE });
      return (
        listed !== "absent" && listed.some((db) => (db as { spec?: { name?: string } }).spec?.name === pgName(entry.id))
      );
    } catch {
      return false;
    }
  }

  // What the sign-in gate is applied with; undefined without the platform's
  // gate service (nothing is gated then).
  async gateInput(discovery: DiscoveryReport | undefined, defaults: Defaults): Promise<GateInput | undefined> {
    if (!this.ctx.services.has("gate")) return undefined;
    const ref = { namespace: this.config.namespace(), service: this.config.release() };
    const readiness = this.ctx.services.get("gate").readiness();
    const host = readiness.ready ? hostOf(readiness.signInUrl) : undefined;
    if (!host) return { console: ref, readiness };
    const publish = publishesConsole(host, defaults, ref, discovery?.ingressHosts ?? [], await this.ingressObjects());
    // The pod isn't where hosts-file names resolve.
    const resolves = defaults.access === "local" ? undefined : await (this.options.resolve ?? lookupHost)(host);
    return { console: ref, readiness, consoleHost: { host, publish, ...(resolves === undefined ? {} : { resolves }) } };
  }

  async gateStatus(refresh = false): Promise<GateStatus> {
    const { discovery } = await this.discover(refresh);
    const defaults = this.effectiveDefaults(discovery);
    const input = (await this.gateInput(discovery, defaults)) ?? {
      console: { namespace: this.config.namespace(), service: this.config.release() },
      readiness: { ready: false, reason: "The sign-in gate is not available in this build.", signInUrl: "" },
    };
    return gateStatus(
      this.entries(),
      this.store.releases(),
      discovery,
      defaults,
      input,
      (id) => this.gates.isPublic(id),
      await this.ingressObjects()
    );
  }

  // Every Ingress in the cluster, or undefined when they can't be listed.
  async ingressObjects(): Promise<KubeObject[] | undefined> {
    try {
      const found = await this.k8s()?.list(RESOURCES.ingresses);
      return Array.isArray(found) ? found : undefined;
    } catch {
      return undefined;
    }
  }

  private async gateActionContext(): Promise<GateActionContext | undefined> {
    const { discovery } = await this.discover();
    const defaults = this.effectiveDefaults(discovery);
    const input = await this.gateInput(discovery, defaults);
    if (!input) return undefined;
    return {
      input,
      defaults,
      entry: (appId) => this.entries().find((e) => e.id === appId),
      isPublic: (appId) => this.gates.isPublic(appId),
      ingresses: () => this.ingressObjects(),
      save: (appId, isPublic, by) => {
        this.gates.set(appId, isPublic, by, this.iso());
      },
    };
  }

  // Puts the saved choice back on the app's Ingresses after a job that may
  // have rewritten them (an upgrade from the values it was installed with).
  async gateSteps(entry: CatalogEntry): Promise<{ steps: Step[]; files: Record<string, string> }> {
    const { discovery } = await this.discover();
    if (!entry.exposesUi || !discovery) return { steps: [], files: {} };
    const defaults = this.effectiveDefaults(discovery);
    const input = await this.gateInput(discovery, defaults);
    if (!input) return { steps: [], files: {} };
    const decision = decide(entry, defaults, this.gates.isPublic(entry.id), input);
    if (decision.state === "tailnet" || decision.state === "open") return { steps: [], files: {} };
    const steps = annotateSteps(
      appIngresses(discovery.ingressHosts, entry.id, await this.ingressObjects()),
      decision.middleware
    );
    if (!decision.middleware) return { steps, files: {} };
    return {
      steps: [applyMiddlewareStep(), ...steps],
      files: { [MIDDLEWARE_FILE]: gateManifests(input, defaults, decision.credentials) },
    };
  }

  async accessView(refresh = false): Promise<AccessView> {
    const { discovery } = await this.discover(refresh);
    return accessView(this.access.get(), discovery, this.options.resolve);
  }

  saveAccess(actor: string, request: AccessRequest): void {
    this.access.set(request, actor, this.iso());
    this.ctx.audit.record({
      actor,
      action: "deploy.set-access",
      target: request.mode,
      detail: `base domain ${request.baseDomain}`,
    });
  }

  async plan(request: DeployRequest, entry?: CatalogEntry): Promise<DeployPlan> {
    return (await this.rendered(request, "install", {}, entry)).plan;
  }

  // --- running -------------------------------------------------------------

  async start(
    actor: string,
    request: DeployJobRequest,
    context: RenderContext = {},
    entry?: CatalogEntry
  ): Promise<DeployJobView> {
    const { plan, files, steps, secrets } = await this.rendered(request, request.mode, context, entry);
    if (!plan.allowed) throw new HttpError(400, plan.blockedBy ?? "This deploy is not allowed.");
    const view = await this.launch(
      actor,
      { ...plan, mode: request.mode, url: request.mode === "install" ? plan.url : undefined },
      files,
      steps,
      secrets
    );
    if (request.mode === "install" && request.public !== undefined) {
      this.gates.set(plan.appId, request.public, actor, this.iso());
    }
    return view;
  }

  async upgradeReport(refresh = false): Promise<UpgradeReport> {
    const [enabled, found] = await Promise.all([this.enabled(), this.discover(refresh)]);
    return upgradeReport({
      entries: this.entries(),
      discovery: found.discovery,
      enabled,
      releases: this.store.releases(),
      versions: this.store.installedVersions(),
      busy: new Set(this.store.active().map((record) => record.view.release)),
      checkedAt: this.iso(),
    });
  }

  // One app of an upgrade run, checked against a fresh report.
  async startUpgrade(actor: string, appId: string): Promise<DeployJobView> {
    const report = await this.upgradeReport(true);
    const app = report.apps.find((a) => a.appId === appId);
    if (!app) throw new HttpError(400, `${appId} was not deployed from here, so it can't be upgraded here.`);
    if ((app.state !== "available" && app.state !== "unknown") || !app.targetVersion) {
      throw new HttpError(400, `${appId}: ${app.reason ?? `nothing to upgrade (${app.state})`}`);
    }
    const entry = this.entries().find((e) => e.id === appId)!;
    const { steps, files, error } = upgradeSteps(
      { entry, release: app.release, namespace: app.namespace },
      app.targetVersion
    );
    if (error) throw new HttpError(400, error);
    const gate = await this.gateSteps(entry);
    steps.push(...gate.steps);
    Object.assign(files, gate.files);
    return this.launch(
      actor,
      {
        appId,
        release: app.release,
        namespace: app.namespace,
        version: app.targetVersion,
        mode: "upgrade",
        url: app.url,
      },
      Object.keys(files).length > 0 ? files : { "values.yaml": "{}\n" },
      steps,
      []
    );
  }

  // --- retries -------------------------------------------------------------

  // Whether discovery sees the app's objects in the cluster: false means the
  // failed attempt never got as far as creating the release; undefined
  // when discovery can't tell.
  async releaseCreated(appId: string): Promise<boolean | undefined> {
    const { discovery } = await this.discover(true);
    const state = discovery?.apps.find((app) => app.appId === appId)?.state;
    return state === "installed" ? true : state === "not-installed" ? false : undefined;
  }

  // The failed install or upgrade, checked for a retry; throws why not.
  retryable(id: string): { record: JobRecord; entry: CatalogEntry } {
    const record = this.mustGet(id);
    const { view } = record;
    if (view.mode !== "install" && view.mode !== "upgrade") {
      throw new HttpError(400, `${id} is not an install or upgrade, so there is nothing to retry.`);
    }
    if (view.state !== "failed" && view.state !== "cancelled") {
      throw new HttpError(400, `${id} did not fail (${view.state}); there is nothing to retry.`);
    }
    if (this.store.laterInstall(view.release, id)) {
      throw new HttpError(400, `${view.release} has been deployed again since ${id}; retry the latest attempt.`);
    }
    const entry = this.entries().find((e) => e.id === view.appId);
    if (!entry) throw new HttpError(400, `${view.appId} is no longer in the catalog.`);
    if (entry.install.kind === "patch") {
      throw new HttpError(400, `${entry.name} is a setting change; deploy it again instead.`);
    }
    return { record, entry };
  }

  // Runs a failed install or upgrade again with the values Helm saved from
  // it (upgradeSteps: --reset-then-reuse-values), so the passwords it
  // generated stay what the data already on disk was made with.
  async retry(actor: string, id: string): Promise<DeployJobView> {
    const { record, entry } = this.retryable(id);
    const { view } = record;
    if (entry.install.kind === "helm" && (await this.releaseCreated(entry.id)) === false) {
      throw new HttpError(
        400,
        `The failed attempt never created ${view.release}, so there are no saved values to retry with; deploy ${entry.name} again.`
      );
    }
    const { steps, files, error } = upgradeSteps(
      { entry, release: view.release, namespace: view.namespace },
      view.version
    );
    if (error) throw new HttpError(400, error);
    const gate = await this.gateSteps(entry);
    steps.push(...gate.steps);
    Object.assign(files, gate.files);
    // Its log is on the record already; the pod would only linger.
    await this.k8s()
      ?.delete?.(RESOURCES.jobs, view.job.name, view.job.namespace)
      .catch(() => undefined);
    const started = await this.launch(
      actor,
      {
        appId: view.appId,
        release: view.release,
        namespace: view.namespace,
        version: view.version,
        mode: view.mode,
        url: view.url,
        retryOf: view.id,
      },
      Object.keys(files).length > 0 ? files : { "values.yaml": "{}\n" },
      steps,
      []
    );
    this.ctx.audit.record({
      actor,
      action: "deploy.retry",
      target: started.id,
      detail: `${view.appId} ${view.version} ${view.mode}, retrying ${view.id}`,
    });
    return started;
  }

  // --- actions -------------------------------------------------------------

  async renderAction(request: DeployActionRequest, call: ActionContext["call"], run = false): Promise<ActionRendered> {
    const recipe = actionRecipe(request.kind) as ActionRecipe | undefined;
    if (!recipe) throw new HttpError(400, `The ${request.kind} action is not available yet.`);
    const enabled = await this.enabled();
    const rendered = await recipe.render(request, {
      run,
      enabled,
      image: this.config.image(),
      ...(enabled ? {} : { enableHint: enableHint(this.config) }),
      call,
      k8s: this.k8s(),
      catalog: this.ctx.services.has("catalog") ? this.catalog() : undefined,
      discover: async () => (await this.discover()).discovery,
      releases: this.store.releases(),
      versions: this.store.installedVersions(),
      gate: await this.gateActionContext(),
      ...(this.ctx.services.has("storage-targets") ? { storageTargets: this.ctx.services.get("storage-targets") } : {}),
      ...(this.consoleDatabase ? { consoleDatabase: this.consoleDatabase } : {}),
    });
    if (!rendered.plan.allowed) return rendered;
    const namespace = this.config.namespace();
    rendered.plan.creates = [
      ...rendered.plan.creates,
      { kind: "Job", name: jobName(rendered.release, this.store.nextSeq()), namespace },
      { kind: "Secret", name: valuesSecretName(rendered.release), namespace },
    ];
    return rendered;
  }

  async startAction(actor: string, request: DeployActionRequest, call: ActionContext["call"]): Promise<DeployJobView> {
    const rendered = await this.renderAction(request, call, true);
    if (!rendered.plan.allowed) throw new HttpError(400, rendered.plan.blockedBy ?? "This action is not allowed.");
    const view = await this.launch(
      actor,
      {
        appId: rendered.appId,
        release: rendered.release,
        namespace: rendered.namespace,
        version: rendered.version,
        mode: "action",
        action: request.kind,
      },
      Object.keys(rendered.files).length > 0 ? rendered.files : { "values.yaml": "{}\n" },
      rendered.steps,
      rendered.secrets ?? [],
      {
        script: rendered.script,
        deadlineSeconds: rendered.deadlineSeconds,
        avoidNode: rendered.avoidNode,
        pod: rendered.pod,
      }
    );
    try {
      await rendered.onStarted?.(view);
    } catch (err) {
      this.ctx.log.warn("A deploy action's start hook failed", { job: view.id, error: errorMessage(err) });
    }
    return view;
  }

  private async launch(
    actor: string,
    plan: {
      appId: string;
      release: string;
      namespace: string;
      version: string;
      mode: DeployJobMode;
      action?: DeployActionKind;
      url?: string;
      retryOf?: string;
    },
    files: Record<string, string>,
    steps: Step[],
    secrets: string[],
    program: { script?: string; deadlineSeconds?: number; avoidNode?: string; pod?: PodExtras } = {}
  ): Promise<DeployJobView> {
    const k8s = this.k8s()!;
    const jobNamespace = this.config.namespace();

    const inserted = this.store.insert(
      {
        appId: plan.appId,
        release: plan.release,
        namespace: plan.namespace,
        version: plan.version,
        mode: plan.mode,
        ...(plan.action ? { action: plan.action } : {}),
        startedBy: actor,
        url: plan.url,
        jobNamespace,
        hasSecrets: secrets.length > 0,
        ...(plan.retryOf ? { retryOf: plan.retryOf } : {}),
        jobName: (seq) => jobName(plan.release, seq),
      },
      this.iso()
    );
    if ("busy" in inserted) {
      throw new HttpError(409, `${plan.release} already has a deploy in progress (${inserted.busy.view.id}).`);
    }
    const { view } = inserted.created;
    await this.remember(view.id, secrets);

    const secretName = valuesSecretName(plan.release);
    try {
      // Left by an earlier run whose Job is still within its TTL.
      await k8s.delete!(RESOURCES.secrets, secretName, jobNamespace);
      const job = await k8s.create!(
        RESOURCES.jobs,
        jobManifest({
          id: view.id,
          name: view.job.name,
          namespace: jobNamespace,
          release: plan.release,
          image: this.config.image(),
          serviceAccount: this.config.serviceAccount(),
          valuesSecret: secretName,
          steps,
          ...program,
        })
      );
      await k8s.create!(
        RESOURCES.secrets,
        valuesSecret({ name: secretName, namespace: jobNamespace, id: view.id, release: plan.release }, files, job)
      );
    } catch (err) {
      const message = `Could not start the Job: ${errorMessage(err)}`;
      this.store.finish(view.id, "failed", this.iso(), message);
      await this.forget(view.id);
      await k8s.delete!(RESOURCES.jobs, view.job.name, jobNamespace).catch(() => undefined);
      this.ctx.audit.record({
        actor,
        action: "deploy.start",
        target: view.id,
        detail: `${plan.appId} ${plan.mode}: ${message}`,
        result: "error",
      });
      throw new HttpError(502, message);
    }

    this.ctx.audit.record({
      actor,
      action: "deploy.start",
      target: view.id,
      detail: plan.action
        ? `${plan.action} on ${plan.appId} in ${plan.namespace} (Job ${jobNamespace}/${view.job.name})`
        : `${plan.appId} ${plan.version} ${plan.mode} into ${plan.namespace} (Job ${jobNamespace}/${view.job.name})`,
    });
    void this.ensureWatch();
    return this.store.get(view.id)!.view;
  }

  async cancel(actor: string, id: string): Promise<DeployJobView> {
    const record = this.mustGet(id);
    if (isFinal(record.view.state)) throw new HttpError(409, `${id} has already finished (${record.view.state}).`);
    const k8s = this.k8s();
    if (!k8s?.delete) throw new HttpError(503, "The Kubernetes API cannot delete Jobs here.");
    const log = await this.capture(record).catch(() => undefined);
    try {
      await k8s.delete(RESOURCES.jobs, record.view.job.name, record.view.job.namespace);
    } catch (err) {
      throw new HttpError(502, `Could not delete the Job: ${errorMessage(err)}`);
    }
    await this.conclude(record, "cancelled", `Cancelled by ${actor}.`, log);
    this.ctx.audit.record({
      actor,
      action: "deploy.cancel",
      target: id,
      detail: `${record.view.appId} ${record.view.mode} (Job ${record.view.job.namespace}/${record.view.job.name})`,
    });
    return this.mustGet(id).view;
  }

  get(id: string): DeployJobView | undefined {
    return this.store.get(id)?.view;
  }

  mustGet(id: string): JobRecord {
    const record = this.store.get(id);
    if (!record) throw new HttpError(404, `No deploy job "${id}".`);
    return record;
  }

  releases(): DeployedRelease[] {
    return this.store.releases();
  }

  list(appId: string | undefined, limit: number): DeployJobView[] {
    return this.store.list({ appId, limit });
  }

  // --- reconciling from the cluster ----------------------------------------

  async ensureWatch(): Promise<void> {
    if (this.watch) return;
    this.watching ??= (async () => {
      const k8s = this.k8s();
      if (!k8s) return;
      const watch = await k8s.watch(
        RESOURCES.jobs,
        { namespace: this.config.namespace(), labelSelector: JOB_LABEL },
        {
          add: (job) => void this.onJob(job),
          update: (job) => void this.onJob(job),
          error: (err) => this.ctx.log.warn("Deploy Job watch error", { error: err.message }),
        }
      );
      if (watch !== "absent") {
        await watch.synced;
        this.watch = watch;
      }
    })()
      .catch((err) => this.ctx.log.warn("Could not watch deploy Jobs", { error: errorMessage(err) }))
      .finally(() => {
        this.watching = undefined;
      });
    await this.watching;
  }

  stop(): void {
    this.watch?.stop();
    this.watch = undefined;
  }

  private async onJob(job: KubeObject): Promise<void> {
    const id = job.metadata.labels?.[JOB_LABEL];
    if (!id) return;
    const record = this.store.get(id);
    if (!record || isFinal(record.view.state)) return;
    this.missing.delete(id);
    const seen = observe(job);
    if (seen.state === "running") this.store.markRunning(id, seen.startedAt ?? this.iso());
    else if (seen.state === "succeeded" || seen.state === "failed") {
      if (seen.startedAt) this.store.markRunning(id, seen.startedAt);
      await this.conclude(record, seen.state, seen.message);
    }
  }

  // A pass over every unfinished job: catches events a watch missed and
  // Jobs deleted out from under a deploy.
  async reconcile(): Promise<void> {
    const active = this.store.active();
    if (active.length === 0) return;
    await this.ensureWatch();
    const k8s = this.k8s();
    if (!this.watch || !k8s) return;
    const jobs = this.watch.list();
    for (const record of active) {
      const job = jobs.find((j) => j.metadata.name === record.view.job.name);
      if (job) {
        await this.onJob(job);
        continue;
      }
      const passes = (this.missing.get(record.view.id) ?? 0) + 1;
      this.missing.set(record.view.id, passes);
      if (passes < MISSING_PASSES) continue;
      const direct = await k8s.get(RESOURCES.jobs, record.view.job.name, record.view.job.namespace).catch(() => null);
      if (direct && direct !== "absent") {
        await this.onJob(direct);
        continue;
      }
      this.missing.delete(record.view.id);
      await this.conclude(this.mustGet(record.view.id), "failed", "The Job was deleted before it finished.");
    }
  }

  private async conclude(
    record: JobRecord,
    state: DeployJobState,
    reason: string | undefined,
    captured?: LogLines
  ): Promise<void> {
    if (isFinal(record.view.state)) return;
    const log = captured ?? (await this.capture(record).catch(() => undefined));
    const message =
      state === "cancelled"
        ? reason
        : ((log && summarize(log.lines, state, record.view.mode, record.view.release)) ??
          reason ??
          log?.lines.findLast((line) => line.trim()));
    if (!this.store.finish(record.view.id, state, this.iso(), message)) return;
    if (log) this.store.saveLog(record.view.id, log);
    await this.forget(record.view.id);
    const view = this.mustGet(record.view.id).view;
    this.ctx.bus.emit("deploy.finished", {
      jobId: view.id,
      appId: view.appId,
      mode: view.mode,
      ...(view.action ? { action: view.action } : {}),
      state: view.state,
      ...(state === "succeeded" && view.url ? { url: view.url } : {}),
    });
  }

  // --- secrets for redaction -----------------------------------------------

  private async remember(id: string, secrets: string[]): Promise<void> {
    if (secrets.length === 0) return;
    this.secretsInMemory.set(id, secrets);
    try {
      await this.ctx.secrets.put("deploy", id, JSON.stringify(secrets));
    } catch (err) {
      this.ctx.log.warn("Deploy secrets kept in this pod only", { job: id, error: errorMessage(err) });
    }
  }

  private async forget(id: string): Promise<void> {
    if (!this.secretsInMemory.delete(id) && !this.store.get(id)?.hasSecrets) return;
    await this.ctx.secrets.delete("deploy", id).catch(() => undefined);
  }

  // null: the job carried secrets this pod cannot get back.
  private async redactorFor(record: JobRecord): Promise<Redactor | null> {
    if (!record.hasSecrets) return createRedactor([]);
    const local = this.secretsInMemory.get(record.view.id);
    if (local) return createRedactor(local);
    try {
      const stored = await this.ctx.secrets.get("deploy", record.view.id);
      if (stored) return createRedactor(JSON.parse(stored) as string[]);
    } catch {
      // Falls through: without the values nothing from the log is shown.
    }
    return null;
  }

  // --- logs ----------------------------------------------------------------

  private async pod(record: JobRecord): Promise<string | undefined> {
    const pods = await this.k8s()?.list(RESOURCES.pods, {
      namespace: record.view.job.namespace,
      labelSelector: `${JOB_LABEL}=${record.view.id}`,
    });
    if (!pods || pods === "absent" || pods.length === 0) return undefined;
    const newest = pods.toSorted((a, b) =>
      (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? "")
    )[0];
    return newest?.metadata.name;
  }

  // The live log of a job's pod, redacted; undefined when there is no pod.
  private async capture(record: JobRecord, tail = LOG_LINES): Promise<LogLines | undefined> {
    const k8s = this.k8s();
    if (!k8s) return undefined;
    const pod = await this.pod(record);
    if (!pod) return undefined;
    const redact = await this.redactorFor(record);
    if (!redact) return { lines: [WITHHELD], redacted: 0, truncated: false };
    const lines: string[] = [];
    let redacted = 0;
    try {
      const stream = await k8s.logs(
        record.view.job.namespace,
        pod,
        { container: CONTAINER, tailLines: tail },
        (raw) => {
          const out = redact(raw);
          if (out.redacted) redacted++;
          lines.push(out.line);
        }
      );
      await stream.done;
    } catch (err) {
      // 400: the container has not started yet.
      if (statusOf(err) === 400) return { lines: [], redacted: 0, truncated: false };
      throw err;
    }
    return { lines, redacted, truncated: lines.length >= tail };
  }

  async logs(id: string, tail: number): Promise<LogLines> {
    const record = this.mustGet(id);
    if (record.log) {
      const lines = record.log.lines.slice(-tail);
      return {
        lines,
        redacted: record.log.redacted,
        truncated: record.log.truncated || lines.length < record.log.lines.length,
      };
    }
    try {
      return (await this.capture(record, tail)) ?? { lines: [], redacted: 0, truncated: false };
    } catch (err) {
      throw new HttpError(502, `Could not read the deploy log: ${errorMessage(err)}`);
    }
  }

  // Server-sent events, one `data:` per line, redacted. A finished job's
  // stored log is sent whole; a running one is followed until its pod ends.
  async follow(id: string, res: Response): Promise<void> {
    const record = this.mustGet(id);
    const conn = { closed: false };
    let heartbeat: NodeJS.Timeout | undefined;
    let stop: (() => void) | undefined;
    const finish = () => {
      if (heartbeat) clearInterval(heartbeat);
      stop?.();
      if (!res.writableEnded) res.end();
    };
    res.on("close", () => {
      conn.closed = true;
      finish();
    });
    const send = (line: string) => {
      if (!conn.closed) res.write(`data: ${JSON.stringify({ line })}\n\n`);
    };

    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx-style proxies buffer a response unless told not to.
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    heartbeat = setInterval(() => {
      if (!conn.closed) res.write(": keep-alive\n\n");
    }, HEARTBEAT_MS);

    if (record.log || isFinal(record.view.state)) {
      for (const line of record.log?.lines ?? []) send(line);
      finish();
      return;
    }
    const k8s = this.k8s();
    const redact = await this.redactorFor(record);
    if (!k8s || !redact) {
      if (!redact) send(WITHHELD);
      finish();
      return;
    }
    let pod: string | undefined;
    const deadline = this.now() + POD_WAIT_MS;
    while (!conn.closed && !(pod = await this.pod(record).catch(() => undefined)) && this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POD_POLL_MS));
    }
    if (conn.closed || !pod) {
      finish();
      return;
    }
    for (;;) {
      try {
        const stream = await k8s.logs(record.view.job.namespace, pod, { container: CONTAINER, follow: true }, (raw) =>
          send(redact(raw).line)
        );
        stop = () => stream.stop();
        if (conn.closed) stream.stop();
        void stream.done.then(finish, finish);
        return;
      } catch (err) {
        // 400: the container has not started yet (the values Secret may
        // still be on its way).
        if (statusOf(err) === 400 && !conn.closed && this.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, POD_POLL_MS));
          continue;
        }
        if (!conn.closed) send(`Could not follow the log: ${errorMessage(err)}`);
        finish();
        return;
      }
    }
  }
}

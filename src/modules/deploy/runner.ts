import type { Response } from "express";
import type { CatalogService, DiscoveryReport } from "../../contracts/catalog.js";
import type {
  DeployJobRequest,
  DeployJobState,
  DeployJobView,
  DeployMode,
  DeployPlan,
  DeployRequest,
  DeployStatus,
  DeployedRelease,
} from "../../contracts/deploy.js";
import { RESOURCES, type K8sApi, type KubeObject, type Watch } from "../../contracts/k8s.js";
import type { ModuleContext } from "../../contracts/module.js";
import type { LogLines } from "../../contracts/workloads.js";
import { HttpError } from "../../runtime/http.js";
import { errorMessage } from "../../runtime/log.js";
import type { Defaults } from "./apps.js";
import { enableHint, type DeployConfig } from "./config.js";
import { CONTAINER, DEADLINE_SECONDS, JOB_LABEL, jobManifest, valuesSecret } from "./job.js";
import { jobName, render, valuesSecretName, type Rendered } from "./plan.js";
import { createRedactor, type Redactor } from "./redact.js";
import { isFinal, type JobRecord, type Store } from "./store.js";

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
          ? `Stopped after ${DEADLINE_SECONDS / 60} minutes without finishing.`
          : failed.message || failed.reason || "The Job failed.",
    };
  }
  if (status.startTime || (status.active ?? 0) > 0) return { state: "running", startedAt: status.startTime };
  return { state: "pending" };
}

// The line a user reads in the job list: Helm's STATUS, or the error.
export function summarize(lines: readonly string[], state: DeployJobState, mode: DeployMode, release: string) {
  const text = lines.map((line) => line.trim()).filter(Boolean);
  if (state === "succeeded") {
    if (mode === "dry-run") return "Dry run passed: nothing was changed.";
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
  now?: () => number;
  // Overrides the random secrets a run generates, for tests.
  generate?: () => string;
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

  constructor(ctx: ModuleContext, store: Store, config: DeployConfig, options: DeployerOptions = {}) {
    this.ctx = ctx;
    this.store = store;
    this.config = config;
    this.options = options;
    this.now = options.now ?? Date.now;
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
    return {
      baseDomain: set.baseDomain ?? found.baseDomain,
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
      defaults: Object.fromEntries(Object.entries(defaults).filter(([, v]) => v !== undefined)),
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

  async rendered(request: DeployRequest, mode: DeployMode, context: RenderContext = {}): Promise<Rendered> {
    const catalog = this.catalog();
    const entry = catalog.get(request.appId);
    if (!entry) throw new HttpError(404, `No app "${request.appId}" in the catalog.`);
    const [enabled, found] = await Promise.all([
      context.enabled ?? this.enabled(),
      context.found ?? this.discover(context.refresh),
    ]);
    const namespace = request.namespace?.trim() || entry.namespace;
    const defaults = this.effectiveDefaults(found.discovery);
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
        jobNamespace: this.config.namespace(),
        jobName: jobName(entry.id, this.store.nextSeq()),
        valuesSecret: valuesSecretName(entry.id),
      },
      mode,
      this.options.generate
    );
  }

  async plan(request: DeployRequest): Promise<DeployPlan> {
    return (await this.rendered(request, "install")).plan;
  }

  // --- running -------------------------------------------------------------

  async start(actor: string, request: DeployJobRequest, context: RenderContext = {}): Promise<DeployJobView> {
    const { plan, files, steps, secrets } = await this.rendered(request, request.mode, context);
    if (!plan.allowed) throw new HttpError(400, plan.blockedBy ?? "This deploy is not allowed.");
    const k8s = this.k8s()!;
    const jobNamespace = this.config.namespace();

    const inserted = this.store.insert(
      {
        appId: plan.appId,
        release: plan.release,
        namespace: plan.namespace,
        version: plan.version,
        mode: request.mode,
        startedBy: actor,
        url: request.mode === "install" ? plan.url : undefined,
        jobNamespace,
        hasSecrets: secrets.length > 0,
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
        detail: `${plan.appId} ${request.mode}: ${message}`,
        result: "error",
      });
      throw new HttpError(502, message);
    }

    this.ctx.audit.record({
      actor,
      action: "deploy.start",
      target: view.id,
      detail: `${plan.appId} ${plan.version} ${request.mode} into ${plan.namespace} (Job ${jobNamespace}/${view.job.name})`,
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

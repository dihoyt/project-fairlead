import type { Database } from "better-sqlite3";
import type { CatalogBundle, CatalogEntry, DiscoveryReport } from "../../contracts/catalog.js";
import type {
  BundlePlan,
  BundlePlanStep,
  BundleRequest,
  BundleRunState,
  BundleRunView,
  BundleStepState,
  DeployRequest,
  DeployValue,
} from "../../contracts/deploy.js";
import type { ModuleContext } from "../../contracts/module.js";
import { HttpError } from "../../runtime/http.js";
import { errorMessage } from "../../runtime/log.js";
import type { Defaults } from "./apps.js";
import { MASK } from "./plan.js";
import type { Deployer, Found } from "./runner.js";
import { isFinal } from "./store.js";

// A step claimed by a pod that never recorded its job (it died between the
// claim and the create) is failed after this long.
const CLAIM_TIMEOUT_MS = 120_000;
// What the cert-manager deploy names the issuer it creates from its email.
const BUNDLE_ISSUER = "letsencrypt-prod";

interface Step {
  appId: string;
  state: BundleStepState;
  jobId?: string;
  message?: string;
  url?: string;
  claimedAt?: string;
}

interface Row {
  id: string;
  bundle_id: string;
  state: BundleRunState;
  started_by: string;
  created_at: string;
  finished_at: string | null;
  steps: string;
  request: string;
  rev: number;
}

interface Run {
  id: string;
  bundleId: string;
  state: BundleRunState;
  startedBy: string;
  createdAt: string;
  finishedAt?: string;
  steps: Step[];
  rev: number;
}

const toRun = (row: Row): Run => ({
  id: row.id,
  bundleId: row.bundle_id,
  state: row.state,
  startedBy: row.started_by,
  createdAt: row.created_at,
  ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  steps: JSON.parse(row.steps) as Step[],
  rev: row.rev,
});

export function view(run: Run): BundleRunView {
  return {
    id: run.id,
    bundleId: run.bundleId,
    state: run.state,
    startedBy: run.startedBy,
    createdAt: run.createdAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    steps: run.steps.map(({ claimedAt: _claimed, ...step }) => step),
  };
}

class RunStore {
  private readonly db: Database;
  private readonly orgId: string;

  constructor(db: Database, orgId: string) {
    this.db = db;
    this.orgId = orgId;
  }

  insert(run: Omit<Run, "id" | "rev">, request: string): Run | { busy: string } {
    const tx = this.db.transaction(() => {
      const running = this.db
        .prepare("SELECT id FROM deploy_bundle_runs WHERE org_id = ? AND state = 'running' LIMIT 1")
        .get(this.orgId) as { id: string } | undefined;
      if (running) return { busy: running.id };
      const { seq } = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM deploy_bundle_runs").get() as {
        seq: number;
      };
      const id = `br_${seq}`;
      this.db
        .prepare(
          `INSERT INTO deploy_bundle_runs (seq, id, org_id, bundle_id, state, started_by, created_at, steps, request)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          seq,
          id,
          this.orgId,
          run.bundleId,
          run.state,
          run.startedBy,
          run.createdAt,
          JSON.stringify(run.steps),
          request
        );
      return this.get(id)!;
    });
    return tx.immediate();
  }

  get(id: string): Run | undefined {
    const row = this.db.prepare("SELECT * FROM deploy_bundle_runs WHERE org_id = ? AND id = ?").get(this.orgId, id) as
      Row | undefined;
    return row ? toRun(row) : undefined;
  }

  list(): Run[] {
    return (
      this.db
        .prepare("SELECT * FROM deploy_bundle_runs WHERE org_id = ? ORDER BY seq DESC LIMIT 50")
        .all(this.orgId) as Row[]
    ).map(toRun);
  }

  running(): Run[] {
    return (
      this.db
        .prepare("SELECT * FROM deploy_bundle_runs WHERE org_id = ? AND state = 'running' ORDER BY seq")
        .all(this.orgId) as Row[]
    ).map(toRun);
  }

  // Applies the change only to the revision the caller read.
  save(run: Run): boolean {
    const result = this.db
      .prepare(
        `UPDATE deploy_bundle_runs SET state = ?, finished_at = ?, steps = ?, rev = rev + 1
         WHERE org_id = ? AND id = ? AND rev = ?`
      )
      .run(run.state, run.finishedAt ?? null, JSON.stringify(run.steps), this.orgId, run.id, run.rev);
    if (result.changes === 1) run.rev++;
    return result.changes === 1;
  }
}

const secretKeys = (inputs: CatalogBundle["inputs"] | CatalogEntry["inputs"]) =>
  new Set(inputs.filter((input) => input.kind === "secret").map((input) => input.key));

function mask(values: Record<string, DeployValue>, secret: Set<string>): Record<string, DeployValue> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, secret.has(k) && v !== "" ? MASK : v]));
}

export interface StepRequest {
  appId: string;
  skip: boolean;
  reason?: string;
  request?: DeployRequest;
}

// Each item's DeployRequest, first match wins per input: the request's
// per-app value, the item's bind, a shared input of the same key, the item's
// literal values; hosts default to <hostPrefix ?? appId>.<baseDomain>.
export function stepRequests(
  bundle: CatalogBundle,
  entries: (appId: string) => CatalogEntry | undefined,
  request: BundleRequest,
  discovery: DiscoveryReport | undefined
): StepRequest[] {
  const shared = request.inputs ?? {};
  const baseDomain = typeof shared.baseDomain === "string" ? shared.baseDomain.trim() : "";
  const included = new Set(request.include ?? []);
  return bundle.items.map((item): StepRequest => {
    const entry = entries(item.appId);
    if (!entry) return { appId: item.appId, skip: true, reason: "Not in this catalog" };
    if (!item.required && !included.has(item.appId)) {
      return { appId: item.appId, skip: true, reason: item.note ?? "Left out" };
    }
    const skip = alreadyDone(entry, discovery);
    if (skip) return { appId: item.appId, skip: true, reason: skip };

    const own = request.apps?.[item.appId] ?? {};
    const inputs: Record<string, DeployValue> = {};
    for (const input of entry.inputs) {
      const bound = item.bind?.[input.key];
      const value =
        own[input.key] ??
        (bound !== undefined ? shared[bound] : undefined) ??
        shared[input.key] ??
        item.values?.[input.key] ??
        (input.key === "host" && baseDomain ? `${item.hostPrefix ?? item.appId}.${baseDomain}` : undefined);
      if (value !== undefined) inputs[input.key] = value;
    }
    return { appId: item.appId, skip: false, request: { appId: item.appId, inputs } };
  });
}

// Installed already, or a cluster basic it would fix is already in place.
function alreadyDone(entry: CatalogEntry, discovery: DiscoveryReport | undefined): string | undefined {
  const detected = discovery?.apps.find((app) => app.appId === entry.id);
  if (entry.install.kind !== "patch" && detected?.state === "installed") {
    return `Already installed (${detected.evidence})`;
  }
  // An app offered only as a cluster basic is there to fix one: with no
  // basic asking for it, the cluster has what it does (a default storage
  // class, say).
  const onlyBasic = entry.slots.length === 1 && entry.slots[0] === "cluster-basics";
  if (onlyBasic && discovery && detected?.state !== "unknown") {
    const wanted = discovery.basics.some((basic) => basic.fixAppIds.includes(entry.id));
    if (!wanted && detected?.state === "not-installed") return "The cluster already has what it provides";
  }
  return undefined;
}

export class Bundles {
  private readonly ctx: ModuleContext;
  private readonly deployer: Deployer;
  private readonly runs: RunStore;
  private readonly now: () => number;
  private readonly requests = new Map<string, BundleRequest>();
  private advancing = Promise.resolve();

  constructor(ctx: ModuleContext, deployer: Deployer, now: () => number = Date.now) {
    this.ctx = ctx;
    this.deployer = deployer;
    this.runs = new RunStore(ctx.db, ctx.orgId);
    this.now = now;
  }

  private iso() {
    return new Date(this.now()).toISOString();
  }

  private bundle(id: string): CatalogBundle {
    if (!this.ctx.services.has("catalog")) throw new HttpError(503, "The app catalog is not available.");
    const bundle = this.ctx.services
      .get("catalog")
      .bundles()
      .find((b) => b.id === id);
    if (!bundle) throw new HttpError(404, `No bundle "${id}" in the catalog.`);
    return bundle;
  }

  private entry = (appId: string) => this.ctx.services.get("catalog").get(appId);

  // Shared answers that act as deploy defaults, and what earlier steps
  // bring: Traefik's ingress class, cert-manager's issuer.
  private defaults(request: BundleRequest, steps: StepRequest[], index: number, found: Found): Defaults {
    const text = (key: string) => {
      const value = request.inputs?.[key];
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    };
    const earlier = steps.slice(0, index).filter((step) => !step.skip);
    const has = (appId: string) => earlier.some((step) => step.appId === appId);
    const issuerAsked = earlier.some((step) => step.appId === "cert-manager" && step.request?.inputs.acmeEmail);
    return {
      baseDomain: text("baseDomain"),
      storageClass: text("storageClass"),
      ingressClass: found.discovery?.suggested.ingressClass ? undefined : has("traefik") ? "traefik" : undefined,
      clusterIssuer: found.discovery?.suggested.clusterIssuer ? undefined : issuerAsked ? BUNDLE_ISSUER : undefined,
    };
  }

  async plan(request: BundleRequest): Promise<BundlePlan> {
    const bundle = this.bundle(request.bundleId);
    const [enabled, found] = await Promise.all([this.deployer.enabled(), this.deployer.discover()]);
    const steps = stepRequests(bundle, this.entry, request, found.discovery);
    const out: BundlePlanStep[] = [];
    for (const [index, step] of steps.entries()) {
      if (step.skip || !step.request) {
        out.push({ appId: step.appId, skip: true, ...(step.reason ? { reason: step.reason } : {}) });
        continue;
      }
      const { plan } = await this.deployer.rendered(step.request, "install", {
        enabled,
        found,
        defaults: this.defaults(request, steps, index, found),
        installedBefore: steps
          .slice(0, index)
          .filter((s) => !s.skip)
          .map((s) => s.appId),
      });
      out.push({ appId: step.appId, skip: false, plan });
    }
    const errors = this.sharedErrors(bundle, request);
    return {
      bundleId: bundle.id,
      allowed: errors.length === 0 && out.every((step) => step.skip || step.plan?.allowed),
      steps: out,
    };
  }

  private sharedErrors(bundle: CatalogBundle, request: BundleRequest): string[] {
    return bundle.inputs
      .filter((input) => input.required)
      .filter((input) => {
        const value = request.inputs?.[input.key];
        return value === undefined || value === "";
      })
      .map((input) => `${input.label}: required`);
  }

  async start(actor: string, request: BundleRequest): Promise<BundleRunView> {
    const bundle = this.bundle(request.bundleId);
    const plan = await this.plan(request);
    if (!plan.allowed) {
      const shared = this.sharedErrors(bundle, request)[0];
      const blocked = plan.steps.find((step) => !step.skip && !step.plan?.allowed);
      throw new HttpError(400, shared ?? `${blocked?.appId}: ${blocked?.plan?.blockedBy ?? "not allowed"}`);
    }
    const inserted = this.runs.insert(
      {
        bundleId: bundle.id,
        state: "running",
        startedBy: actor,
        createdAt: this.iso(),
        steps: plan.steps.map((step) =>
          step.skip
            ? { appId: step.appId, state: "skipped", ...(step.reason ? { message: step.reason } : {}) }
            : { appId: step.appId, state: "pending" }
        ),
      },
      JSON.stringify(this.masked(bundle, request))
    );
    if ("busy" in inserted) throw new HttpError(409, `Bundle run ${inserted.busy} is still running.`);
    this.requests.set(inserted.id, request);
    try {
      await this.ctx.secrets.put("deploy", inserted.id, JSON.stringify(request));
    } catch (err) {
      this.ctx.log.warn("Bundle answers kept in this pod only", { run: inserted.id, error: errorMessage(err) });
    }
    this.ctx.audit.record({
      actor,
      action: "deploy.start-bundle",
      target: inserted.id,
      detail: `${bundle.id}: ${plan.steps
        .filter((s) => !s.skip)
        .map((s) => s.appId)
        .join(", ")}`,
    });
    await this.advanceAll();
    return view(this.runs.get(inserted.id)!);
  }

  private masked(bundle: CatalogBundle, request: BundleRequest): BundleRequest {
    const sharedSecret = secretKeys(bundle.inputs);
    return {
      ...request,
      inputs: mask(request.inputs ?? {}, sharedSecret),
      ...(request.apps
        ? {
            apps: Object.fromEntries(
              Object.entries(request.apps).map(([appId, values]) => [
                appId,
                mask(values, secretKeys(this.entry(appId)?.inputs ?? [])),
              ])
            ),
          }
        : {}),
    };
  }

  private async request(run: Run): Promise<BundleRequest | undefined> {
    const local = this.requests.get(run.id);
    if (local) return local;
    try {
      const stored = await this.ctx.secrets.get("deploy", run.id);
      if (stored) return JSON.parse(stored) as BundleRequest;
    } catch {
      // Falls through to failing the run: its answers are gone.
    }
    return undefined;
  }

  get(id: string): BundleRunView {
    const run = this.runs.get(id);
    if (!run) throw new HttpError(404, `No bundle run "${id}".`);
    return view(run);
  }

  list(): BundleRunView[] {
    return this.runs.list().map(view);
  }

  async cancel(actor: string, id: string): Promise<BundleRunView> {
    const run = this.runs.get(id);
    if (!run) throw new HttpError(404, `No bundle run "${id}".`);
    if (run.state !== "running") throw new HttpError(409, `${id} has already finished (${run.state}).`);
    const current = run.steps.find((step) => step.state === "running");
    if (current?.jobId) {
      const job = this.deployer.mustGet(current.jobId);
      if (!isFinal(job.view.state)) await this.deployer.cancel(actor, current.jobId);
    }
    await this.serial(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const fresh = this.runs.get(id)!;
        if (fresh.state !== "running") return;
        for (const step of fresh.steps) {
          if (step.state === "running") {
            step.state = "cancelled";
            step.message = `Cancelled by ${actor}.`;
          }
        }
        if (await this.finishRun(fresh, "cancelled")) return;
      }
    });
    this.ctx.audit.record({ actor, action: "deploy.cancel-bundle", target: id, detail: run.bundleId });
    return this.get(id);
  }

  private async finishRun(run: Run, state: BundleRunState): Promise<boolean> {
    run.state = state;
    run.finishedAt = this.iso();
    if (!this.runs.save(run)) return false;
    this.requests.delete(run.id);
    await this.ctx.secrets.delete("deploy", run.id).catch(() => undefined);
    this.ctx.bus.emit("deploy.bundle-finished", { runId: run.id, bundleId: run.bundleId, state });
    return true;
  }

  // One advance at a time in this pod; the revision check covers the other.
  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.advancing.then(fn, fn);
    this.advancing = next.catch(() => undefined);
    return next;
  }

  advanceAll(): Promise<void> {
    return this.serial(async () => {
      for (const run of this.runs.running()) {
        try {
          await this.advance(run);
        } catch (err) {
          this.ctx.log.error("Bundle run could not advance", { run: run.id, error: errorMessage(err) });
        }
      }
    });
  }

  // An optional item that fails is recorded and the rollout moves on; a
  // required one stops it. An item gone from the catalog counts as required.
  private optional(run: Run, appId: string): boolean {
    const item = this.bundle(run.bundleId).items.find((i) => i.appId === appId);
    return item ? !item.required : false;
  }

  // Moves a run on from its current step: records a finished job, starts
  // the next pending step, or finishes the run.
  private async advance(run: Run): Promise<void> {
    const current = run.steps.find((step) => step.state === "running");
    if (current) {
      if (!current.jobId) {
        const claimed = Date.parse(current.claimedAt ?? run.createdAt);
        if (this.now() - claimed < CLAIM_TIMEOUT_MS) return;
        current.state = "failed";
        current.message = "The step was claimed but its job never started.";
        delete current.claimedAt;
        if (!this.optional(run, current.appId)) {
          await this.finishRun(run, "failed");
          return;
        }
        if (!this.runs.save(run)) return;
        return this.advance(run);
      }
      const job = this.deployer.mustGet(current.jobId).view;
      if (!isFinal(job.state)) return;
      current.state = job.state as BundleStepState;
      if (job.message) current.message = job.message;
      if (job.url) current.url = job.url;
      if (job.state === "cancelled" || (job.state === "failed" && !this.optional(run, current.appId))) {
        await this.finishRun(run, job.state === "cancelled" ? "cancelled" : "failed");
        return;
      }
      if (!this.runs.save(run)) return;
    }

    const next = run.steps.find((step) => step.state === "pending");
    if (!next) {
      await this.finishRun(run, run.steps.some((step) => step.state === "failed") ? "failed" : "succeeded");
      return;
    }
    const request = await this.request(run);
    if (!request) {
      next.state = "failed";
      next.message = "This pod cannot read the bundle's answers (SECRETS_KEY is not set); start it again.";
      await this.finishRun(run, "failed");
      return;
    }
    // Claim the step before starting its job, so the other pod can't.
    next.state = "running";
    next.claimedAt = this.iso();
    if (!this.runs.save(run)) return;

    const bundle = this.bundle(run.bundleId);
    const found = await this.deployer.discover(true);
    const steps = stepRequests(bundle, this.entry, request, found.discovery);
    const index = steps.findIndex((step) => step.appId === next.appId);
    const step = steps[index];
    try {
      if (!step || step.skip || !step.request) {
        next.state = "skipped";
        next.message = step?.reason ?? "Nothing to do";
      } else {
        const job = await this.deployer.start(
          run.startedBy,
          { ...step.request, mode: "install" },
          {
            found,
            defaults: this.defaults(request, steps, index, found),
            installedBefore: run.steps.filter((s) => s.state === "succeeded").map((s) => s.appId),
          }
        );
        next.jobId = job.id;
        if (job.url) next.url = job.url;
        delete next.claimedAt;
      }
    } catch (err) {
      next.state = "failed";
      next.message = errorMessage(err);
      delete next.claimedAt;
      if (!this.optional(run, next.appId)) {
        await this.finishRun(run, "failed");
        return;
      }
    }
    if (!this.runs.save(run)) return;
    // A skipped step, or an optional one that failed to start, leaves
    // nothing to wait for.
    if (next.state === "skipped" || next.state === "failed") await this.advance(run);
  }
}

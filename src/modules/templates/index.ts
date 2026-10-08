import { z } from "zod";
import type { CatalogEntry } from "../../contracts/catalog.js";
import type { DeployJobView, DeployRequest, DeployService } from "../../contracts/deploy.js";
import type { Module, ModuleContext } from "../../contracts/module.js";
import {
  CUSTOM_TEMPLATE,
  type CustomAppSpec,
  type TemplateDeployRequest,
  type TemplateInstance,
  type TemplatePlan,
  type TemplatesService,
} from "../../contracts/templates.js";
import { compareVersions } from "../../contracts/kubeversion.js";
import { HttpError } from "../../runtime/http.js";
import { checkManifests } from "./guardrail.js";
import {
  CUSTOM,
  DNS_LABEL,
  ENV_NAME,
  LIBRARY,
  MOUNT_PATH,
  SIZE,
  parseImage,
  templateView,
  type TemplateDefinition,
} from "./library.js";
import { migrations } from "./migrations.js";
import { entryFor, fromDefinition, manifests, toDocuments, type Resolved } from "./render.js";
import { Store, type InstanceRecord } from "./store.js";

const MAX_NAME = 40;
const STORAGE_CLASS = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const MAX_ENV = 50;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

const text = (max: number) => z.string().max(max);
const requestSchema = z.object({
  templateId: z.string().min(1).max(100),
  name: text(100).optional(),
  host: text(253).optional(),
  volumeSize: text(20).optional(),
  storageClass: text(253).optional(),
  custom: z
    .object({
      image: text(300),
      port: z.number(),
      env: z
        .array(z.object({ name: text(256), value: text(4096) }))
        .max(200)
        .default([]),
      volume: z.object({ size: text(20), mountPath: text(300) }).optional(),
    })
    .optional(),
});
const jobSchema = requestSchema.extend({ mode: z.enum(["install", "dry-run"]) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HttpError(400, `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  return result.data;
}

interface Resolution {
  templateId: string;
  name: string;
  errors: Record<string, string>;
  // Absent when field errors stop the render.
  resolved?: Resolved;
  custom?: CustomAppSpec;
  host?: string;
  volumeSize?: string;
  storageClass?: string;
}

function definition(templateId: string): TemplateDefinition | undefined {
  return LIBRARY.find((t) => t.id === templateId);
}

function checkCustom(spec: CustomAppSpec | undefined, errors: Record<string, string>) {
  if (!spec) {
    errors.custom = "required for a custom app";
    return undefined;
  }
  const image = parseImage(spec.image);
  if ("error" in image) errors["custom.image"] = image.error;
  if (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65_535) {
    errors["custom.port"] = "must be a port number from 1 to 65535";
  }
  if (spec.env.length > MAX_ENV) errors["custom.env"] = `at most ${MAX_ENV} variables`;
  const seen = new Set<string>();
  spec.env.forEach((e, i) => {
    if (!ENV_NAME.test(e.name)) errors[`custom.env.${i}.name`] = "letters, digits and _, not starting with a digit";
    else if (seen.has(e.name)) errors[`custom.env.${i}.name`] = "given twice";
    seen.add(e.name);
    if (CONTROL.test(e.value)) errors[`custom.env.${i}.value`] = "has control characters";
  });
  if (spec.volume) {
    if (!SIZE.test(spec.volume.size)) errors["custom.volume.size"] = "must be a size like 5Gi";
    if (!MOUNT_PATH.test(spec.volume.mountPath) || spec.volume.mountPath === "/") {
      errors["custom.volume.mountPath"] = "must be an absolute path like /data";
    }
  }
  return "error" in image ? undefined : image;
}

export class Templates {
  readonly store: Store;
  private readonly ctx: ModuleContext;
  private readonly now: () => number;

  constructor(ctx: ModuleContext, now: () => number = Date.now) {
    this.ctx = ctx;
    this.now = now;
    this.store = new Store(ctx.db, ctx.orgId);
  }

  private deploy(): DeployService {
    if (!this.ctx.services.has("deploy")) throw new HttpError(503, "The deploy runner is not available.");
    return this.ctx.services.get("deploy");
  }

  private catalogIds(): Set<string> {
    if (!this.ctx.services.has("catalog")) return new Set();
    return new Set(
      this.ctx.services
        .get("catalog")
        .entries()
        .map((e) => e.id)
    );
  }

  resolve(request: TemplateDeployRequest): Resolution {
    const custom = request.templateId === CUSTOM_TEMPLATE;
    const def = definition(request.templateId);
    if (!custom && !def) throw new HttpError(404, `No template "${request.templateId}".`);
    const errors: Record<string, string> = {};
    const name = (request.name ?? "").trim().toLowerCase() || (custom ? "" : request.templateId);
    if (!name) errors.name = "required";
    else if (name.length > MAX_NAME || !DNS_LABEL.test(name)) {
      errors.name = `lowercase letters, digits and dashes, at most ${MAX_NAME} characters`;
    } else if (this.catalogIds().has(name)) errors.name = `${name} is an app in the catalog; pick another name`;
    else {
      const other = this.store.get(name);
      if (other && other.templateId !== request.templateId) errors.name = `already used by a ${other.templateId} app`;
    }
    if (!custom && request.custom) errors.custom = "only for a custom app";

    const host = request.host === undefined ? undefined : request.host.trim().toLowerCase();
    const volumeSize = request.volumeSize?.trim() || undefined;
    const storageClass = request.storageClass?.trim() || undefined;
    if (volumeSize && !SIZE.test(volumeSize)) errors.volumeSize = "must be a size like 5Gi";
    if (storageClass && !STORAGE_CLASS.test(storageClass)) errors.storageClass = "must be a storage class name";

    const image = custom ? checkCustom(request.custom, errors) : undefined;
    const base = {
      templateId: request.templateId,
      name,
      errors,
      ...(host !== undefined ? { host } : {}),
      ...(volumeSize ? { volumeSize } : {}),
      ...(storageClass ? { storageClass } : {}),
    };
    if (Object.keys(errors).length > 0) return { ...base, ...(request.custom ? { custom: request.custom } : {}) };

    const exposed = host !== "";
    if (def) {
      return { ...base, resolved: fromDefinition(def, name, { exposed, volumeSize, storageClass }) };
    }
    const spec = request.custom!;
    const volume = spec.volume ? { size: volumeSize ?? spec.volume.size, mountPath: spec.volume.mountPath } : undefined;
    const tidy: CustomAppSpec = {
      image: spec.image.trim(),
      port: spec.port,
      env: spec.env,
      ...(volume ? { volume } : {}),
    };
    return {
      ...base,
      custom: tidy,
      resolved: {
        templateId: CUSTOM_TEMPLATE,
        name,
        displayName: CUSTOM.name,
        summary: `${tidy.image} on port ${tidy.port}`,
        image: image!.digest
          ? `${image!.name}${image!.tag ? `:${image!.tag}` : ""}@${image!.digest}`
          : `${image!.name}:${image!.tag}`,
        version: image!.version,
        port: tidy.port,
        env: tidy.env,
        ...(volume ? { volume: { ...volume, ...(storageClass ? { storageClass } : {}) } } : {}),
        exposed,
      },
    };
  }

  private deployRequest(r: Resolution): DeployRequest {
    return { appId: r.name, inputs: r.host ? { host: r.host } : {} };
  }

  async plan(
    request: TemplateDeployRequest
  ): Promise<{ plan: TemplatePlan; entry?: CatalogEntry; resolution: Resolution }> {
    const resolution = this.resolve(request);
    const { resolved, errors, name, templateId } = resolution;
    const base = { templateId, name, namespace: name };
    if (!resolved) {
      const [field, error] = Object.entries(errors)[0]!;
      return {
        plan: {
          ...base,
          allowed: false,
          blockedBy: `${field}: ${error}`,
          fieldErrors: errors,
          violations: [],
          manifests: "",
        },
        resolution,
      };
    }
    const objects = manifests(resolved);
    const violations = checkManifests(objects, name);
    const entry = entryFor(resolved, objects);
    const deploy = await this.deploy().planEntry(entry, this.deployRequest(resolution));
    const fieldErrors = { ...errors, ...deploy.inputErrors };
    const firstField = Object.entries(fieldErrors)[0];
    const blockedBy = violations[0]
      ? `${violations[0].object}: ${violations[0].message}`
      : firstField
        ? `${firstField[0]}: ${firstField[1]}`
        : deploy.blockedBy;
    return {
      plan: {
        ...base,
        allowed: violations.length === 0 && !firstField && deploy.allowed,
        ...(blockedBy ? { blockedBy } : {}),
        fieldErrors,
        violations,
        manifests: toDocuments(objects),
        deploy,
      },
      entry,
      resolution,
    };
  }

  async start(actor: string, request: TemplateDeployRequest & { mode: "install" | "dry-run" }): Promise<DeployJobView> {
    const name = (request.name ?? "").trim().toLowerCase() || request.templateId;
    const other = this.store.get(name);
    if (other && other.templateId !== request.templateId) {
      throw new HttpError(409, `${name} is already used by a ${other.templateId} app.`);
    }
    const { plan, entry, resolution } = await this.plan(request);
    if (!plan.allowed || !entry) throw new HttpError(400, plan.blockedBy ?? "This deploy is not allowed.");
    const job = await this.deploy().startEntry(actor, entry, { ...this.deployRequest(resolution), mode: request.mode });
    if (request.mode === "install") {
      const host = plan.deploy?.inputs.host;
      this.store.save(
        {
          name: plan.name,
          templateId: plan.templateId,
          version: resolution.resolved!.version,
          host: entry.exposesUi && typeof host === "string" ? host : "",
          ...(resolution.volumeSize ? { volumeSize: resolution.volumeSize } : {}),
          ...(resolution.storageClass ? { storageClass: resolution.storageClass } : {}),
          ...(resolution.custom ? { custom: resolution.custom } : {}),
          lastJobId: job.id,
          createdBy: other?.createdBy ?? actor,
        },
        new Date(this.now()).toISOString()
      );
    }
    this.ctx.audit.record({
      actor,
      action: "templates.deploy",
      target: plan.name,
      detail: `${plan.templateId} ${resolution.resolved!.image} ${request.mode} (job ${job.id})`,
    });
    return job;
  }

  // The saved answers, re-resolved at the library's current pin.
  private resolveRecord(record: InstanceRecord): Resolution | undefined {
    try {
      const resolution = this.resolve({
        templateId: record.templateId,
        name: record.name,
        host: record.host,
        ...(record.volumeSize ? { volumeSize: record.volumeSize } : {}),
        ...(record.storageClass ? { storageClass: record.storageClass } : {}),
        ...(record.custom ? { custom: record.custom } : {}),
      });
      return resolution.resolved ? resolution : undefined;
    } catch {
      return undefined;
    }
  }

  entries(): CatalogEntry[] {
    return this.store.list().flatMap((record) => {
      const resolved = this.resolveRecord(record)?.resolved;
      return resolved ? [entryFor(resolved, manifests(resolved))] : [];
    });
  }

  instances(jobs: readonly DeployJobView[]): TemplateInstance[] {
    return this.store.list().map((record) => {
      const pin = definition(record.templateId)?.version;
      const newer = pin && pin !== record.version && (compareVersions(pin, record.version) ?? 0) > 0;
      const lastJob = jobs.find((j) => j.id === record.lastJobId);
      const url = lastJob?.url ?? jobs.find((j) => j.appId === record.name && j.url)?.url;
      return {
        name: record.name,
        templateId: record.templateId,
        namespace: record.name,
        version: record.version,
        ...(newer ? { newerVersion: pin } : {}),
        host: record.host,
        ...(url ? { url } : {}),
        ...(record.volumeSize ? { volumeSize: record.volumeSize } : {}),
        ...(record.storageClass ? { storageClass: record.storageClass } : {}),
        ...(record.custom ? { custom: record.custom } : {}),
        ...(lastJob ? { lastJob } : {}),
        createdBy: record.createdBy,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    });
  }

  // An upgrade from the Upgrades page installs the library's pin.
  // A succeeded remove-app action forgets the instance.
  finished(event: { jobId: string; appId: string; mode: string; action?: string; state: string }): void {
    const record = this.store.get(event.appId);
    if (!record || event.mode === "dry-run") return;
    if (event.action === "remove-app" && event.state === "succeeded") {
      this.store.delete(record.name);
      return;
    }
    const pin = definition(record.templateId)?.version;
    const version = event.mode === "upgrade" && event.state === "succeeded" && pin ? pin : record.version;
    const { createdAt: _c, updatedAt: _u, ...rest } = record;
    this.store.save({ ...rest, version, lastJobId: event.jobId }, new Date(this.now()).toISOString());
  }
}

export function registerTemplates(ctx: ModuleContext, now?: () => number): Templates {
  const templates = new Templates(ctx, now);
  const service: TemplatesService = { entries: () => templates.entries() };
  ctx.services.provide("templates", service);
  ctx.bus.on("deploy.finished", (event) => templates.finished(event));

  ctx.route("GET /api/templates", async (req) => {
    const jobs = ctx.services.has("deploy")
      ? await ctx.call(req, "GET /api/deploy/jobs", { query: { limit: "200" } }).catch(() => [])
      : [];
    return {
      templates: [...LIBRARY.map(templateView), CUSTOM],
      instances: templates.instances(jobs),
    };
  });

  ctx.route("POST /api/templates/plan", async (req, res) => {
    if (!ctx.require(req, res, "write")) return undefined;
    return (await templates.plan(parse(requestSchema, req.body) as TemplateDeployRequest)).plan;
  });

  ctx.route("POST /api/templates/jobs", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    return templates.start(user.id, parse(jobSchema, req.body));
  });

  return templates;
}

const mod: Module = {
  id: "templates",
  milestone: "B",
  migrations,
  register(ctx) {
    registerTemplates(ctx);
  },
};

export default mod;

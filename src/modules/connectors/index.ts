import { z } from "zod";
import type { ConnectorCapability } from "../../contracts/connectors.js";
import type { Category, CheckResult } from "../../contracts/health.js";
import type { Module, ModuleContext } from "../../contracts/module.js";
import { HttpError } from "../../runtime/http.js";
import { createConnectors, kindView } from "./engine.js";
import { migrations } from "./migrations.js";

const HEALTH_MS = 5 * 60_000;
const RECONCILE_MS = 10 * 60_000;

const values = z.record(z.string(), z.unknown());
const createSchema = z.object({
  kind: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(100),
  values,
});
const updateSchema = z.object({ name: z.string().trim().min(1).max(100).optional(), values: values.optional() });
const testSchema = z.object({ kind: z.string().trim().min(1).max(64), values, id: z.string().max(64).optional() });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

// Identity tools land on the identity tile; everything else is access.
const categoryOf = (capabilities: readonly ConnectorCapability[]): Category =>
  capabilities.includes("identity") ? "identity" : "access";

function register(ctx: ModuleContext): void {
  const connectors = createConnectors({ db: ctx.db, orgId: ctx.orgId, secrets: ctx.secrets, log: ctx.log });
  ctx.services.provide("connectors", connectors.registry);

  // One check per instance on its category's tile. collect() runs the
  // instance's health so the board's interval drives it.
  for (const category of ["access", "identity"] as const) {
    ctx.health.addProvider({
      id: `connectors.${category}`,
      category,
      label: "Connectors",
      intervalMs: HEALTH_MS,
      async collect(): Promise<CheckResult[]> {
        const results: CheckResult[] = [];
        for (const row of connectors.rows()) {
          const kind = connectors.kind(row.kind);
          if (categoryOf(kind?.capabilities ?? []) !== category) continue;
          await connectors.check(row.id).catch(() => undefined);
          const view = await connectors.get(row.id).catch(() => undefined);
          if (!view) continue;
          const bad = view.checks.filter((c) => c.status !== "ok" && c.status !== "absent");
          results.push({
            id: view.id,
            label: `${kind?.label ?? view.kind}: ${view.name}`,
            status: view.status,
            detail:
              bad.length === 0
                ? `${view.checks.length} check${view.checks.length === 1 ? "" : "s"} OK`
                : bad.map((c) => `${c.label}: ${c.detail}`).join("; "),
            ...(bad.length > 0 ? { raw: bad } : {}),
            observedAt: view.checkedAt ?? new Date().toISOString(),
          });
        }
        return results;
      },
    });
  }

  ctx.scheduler.every(
    "connectors.reconcile",
    RECONCILE_MS,
    async () => {
      for (const row of connectors.rows()) {
        if (!connectors.kind(row.kind)?.reconcile) continue;
        await connectors.registry.reconcile(row.id).catch(() => undefined);
      }
    },
    { timeoutMs: 5 * 60_000 }
  );

  ctx.route("GET /api/connectors/kinds", () => connectors.kinds().map(kindView));

  ctx.route("GET /api/connectors", () => connectors.list());

  ctx.route("GET /api/connectors/:id", (req) => connectors.get(req.params.id));

  ctx.route("POST /api/connectors/test", async (req, res) => {
    if (!ctx.require(req, res, "admin")) return undefined;
    const body = parse(testSchema, req.body);
    return connectors.test(body.kind, body.values, body.id);
  });

  ctx.route("POST /api/connectors", async (req, res) => {
    const user = ctx.require(req, res, "admin");
    if (!user) return undefined;
    const body = parse(createSchema, req.body);
    const view = await connectors.create({ ...body, values: body.values as Record<string, string> }, user.id);
    ctx.audit.record({
      actor: user.id,
      action: "connectors.create",
      target: view.id,
      detail: `${view.kind} "${view.name}"`,
    });
    if (connectors.kind(view.kind)?.reconcile && view.status !== "crit") {
      void connectors.registry.reconcile(view.id).catch(() => undefined);
    }
    return view;
  });

  ctx.route("PUT /api/connectors/:id", async (req, res) => {
    const user = ctx.require(req, res, "admin");
    if (!user) return undefined;
    const body = parse(updateSchema, req.body);
    const { view, secretsChanged } = await connectors.update(req.params.id, {
      ...(body.name ? { name: body.name } : {}),
      ...(body.values ? { values: body.values as Record<string, string> } : {}),
    });
    ctx.audit.record({
      actor: user.id,
      action: "connectors.update",
      target: view.id,
      detail: `${view.kind} "${view.name}"${secretsChanged.length > 0 ? ` (changed ${secretsChanged.join(", ")})` : ""}`,
    });
    return view;
  });

  ctx.route("POST /api/connectors/:id/test", async (req, res) => {
    if (!ctx.require(req, res, "admin")) return undefined;
    await connectors.check(req.params.id);
    return connectors.get(req.params.id);
  });

  ctx.route("POST /api/connectors/:id/reconcile", async (req, res) => {
    const user = ctx.require(req, res, "admin");
    if (!user) return undefined;
    const view = await connectors.get(req.params.id);
    if (!connectors.kind(view.kind)?.reconcile) throw new HttpError(400, "This connector keeps nothing in sync.");
    await connectors.registry.reconcile(view.id).catch(() => undefined);
    ctx.audit.record({ actor: user.id, action: "connectors.reconcile", target: view.id, detail: view.kind });
    return connectors.get(view.id);
  });

  ctx.route("DELETE /api/connectors/:id", async (req, res) => {
    const user = ctx.require(req, res, "admin");
    if (!user) return undefined;
    const view = await connectors.get(req.params.id);
    const result = await connectors.remove(view.id, req.query.cleanup === "1");
    ctx.audit.record({
      actor: user.id,
      action: "connectors.delete",
      target: view.id,
      detail: `${view.kind} "${view.name}"${req.query.cleanup === "1" ? `, removed ${result.removed} objects` : ""}${
        result.errors.length > 0 ? `, ${result.errors.length} could not be removed` : ""
      }`,
    });
    return result;
  });
}

const mod: Module = {
  id: "connectors",
  milestone: "B",
  migrations,
  register,
};

export default mod;

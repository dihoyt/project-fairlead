import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { CheckRequest, CheckView } from "../../contracts/checks.js";
import type { CheckResult } from "../../contracts/health.js";
import type { Module, ModuleContext } from "../../contracts/module.js";
import { HttpError } from "../../runtime/http.js";
import { migrations } from "./migrations.js";
import { judge, parseHostPort, probe, type CheckSpec } from "./probe.js";
import { createStore, toView, type CheckFields, type CheckRow, type Store } from "./store.js";

// The provider ticks this often and runs whichever checks are due, so each
// check keeps its own interval behind a single health provider.
export const TICK_MS = 15_000;
export const MIN_INTERVAL_MS = TICK_MS;
// Below the health module's collect() timeout for this provider (its interval).
export const MAX_TIMEOUT_MS = 12_000;
export const LATENCY_SERIES = "check.latency.ms";

const checkRequest = z
  .object({
    label: z.string().trim().min(1).max(100),
    kind: z.enum(["http", "tcp"]),
    target: z.string().trim().min(1).max(2048),
    intervalMs: z.number().int().min(MIN_INTERVAL_MS).max(86_400_000).optional(),
    timeoutMs: z.number().int().min(500).max(MAX_TIMEOUT_MS).optional(),
    expectStatus: z.array(z.number().int().min(100).max(599)).max(20).optional(),
    bodyMatch: z.string().max(1000).optional(),
    authHeader: z
      .string()
      .trim()
      .regex(/^([A-Za-z0-9!#$%&'*+.^_`|~-]{1,64})?$/, "Must be a header name, e.g. Authorization.")
      .optional(),
    // CR, LF or NUL in a header value would be refused by node at request time.
    secret: z
      .string()
      .max(4096)
      .regex(/^[^\r\n\0]*$/, "Must be a single line.")
      .optional(),
    insecureSkipVerify: z.boolean().optional(),
    tlsWarnDays: z.number().int().min(0).max(365).optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((req, issue) => {
    if (req.kind === "tcp") {
      if (!parseHostPort(req.target))
        issue.addIssue({ code: "custom", path: ["target"], message: "Must be host:port." });
      for (const key of ["expectStatus", "bodyMatch", "authHeader", "secret"] as const) {
        if (req[key]?.length) issue.addIssue({ code: "custom", path: [key], message: "Only for http checks." });
      }
      if (req.insecureSkipVerify) {
        issue.addIssue({ code: "custom", path: ["insecureSkipVerify"], message: "Only for http checks." });
      }
      return;
    }
    let url: URL;
    try {
      url = new URL(req.target);
    } catch {
      issue.addIssue({ code: "custom", path: ["target"], message: "Must be an http(s) URL." });
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      issue.addIssue({ code: "custom", path: ["target"], message: "Must be an http(s) URL." });
    }
    // The target is shown in results and deep links, so it can't carry a credential.
    if (url.username || url.password) {
      issue.addIssue({ code: "custom", path: ["target"], message: "Must not contain a username or password." });
    }
  });

interface Parsed {
  fields: CheckFields;
  // undefined: keep the stored value; "": remove it.
  secret?: string;
}

function parseRequest(body: unknown): Parsed {
  const parsed = checkRequest.safeParse(body ?? {});
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  const req: CheckRequest = parsed.data;
  const fields: CheckFields = {
    label: req.label,
    kind: req.kind,
    target: req.target,
    intervalMs: req.intervalMs ?? 60_000,
    timeoutMs: req.timeoutMs ?? 10_000,
    ...(req.expectStatus?.length ? { expectStatus: [...new Set(req.expectStatus)] } : {}),
    ...(req.bodyMatch ? { bodyMatch: req.bodyMatch } : {}),
    ...(req.authHeader ? { authHeader: req.authHeader } : {}),
    insecureSkipVerify: req.insecureSkipVerify ?? false,
    tlsWarnDays: req.tlsWarnDays ?? 21,
    enabled: req.enabled ?? true,
  };
  if (req.secret && !fields.authHeader) throw new HttpError(400, "secret: needs authHeader to say where it goes.");
  return req.secret === undefined ? { fields } : { fields, secret: req.secret };
}

function describe(fields: CheckFields): string {
  return `${fields.kind} ${fields.target}${fields.insecureSkipVerify ? " (certificate not verified)" : ""}`;
}

function specOf(row: CheckRow): CheckSpec {
  const { last: _last, hasSecret: _hasSecret, ...spec } = toView(row, false);
  return spec;
}

export interface Runner {
  run(row: CheckRow): Promise<CheckResult>;
  collect(): Promise<CheckResult[]>;
}

export function createRunner(ctx: ModuleContext, store: Store, now: () => number = Date.now): Runner {
  async function run(row: CheckRow): Promise<CheckResult> {
    const spec = specOf(row);
    const startedAt = now();
    let result: CheckResult;
    try {
      const secret = spec.authHeader ? await ctx.secrets.get("checks", spec.id) : null;
      const outcome = await probe(spec, { now, ...(secret ? { secret } : {}) });
      result = judge(spec, outcome, new Date(startedAt).toISOString());
      if (outcome.latencyMs !== undefined) {
        ctx.metrics.write([
          {
            series: LATENCY_SERIES,
            labels: { check: spec.id, kind: spec.kind },
            ts: startedAt,
            value: outcome.latencyMs,
          },
        ]);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = {
        id: spec.id,
        label: spec.label,
        status: "unknown",
        detail: `Could not run the check: ${message}`,
        raw: { target: spec.target, error: message },
        observedAt: new Date(startedAt).toISOString(),
      };
    }
    store.recordResult(spec.id, spec.target, result, startedAt);
    return result;
  }

  async function collect(): Promise<CheckResult[]> {
    const rows = store.list();
    const at = now();
    const due = rows.filter((r) => r.enabled === 1 && (r.last_run_at === null || at - r.last_run_at >= r.interval_ms));
    const fresh = new Map<string, CheckResult>();
    await Promise.all(due.map(async (row) => fresh.set(row.id, await run(row))));

    return rows.map((row): CheckResult => {
      if (row.enabled !== 1) {
        return {
          id: row.id,
          label: row.label,
          status: "absent",
          detail: "Disabled",
          observedAt: new Date(at).toISOString(),
        };
      }
      const result = fresh.get(row.id) ?? (row.last_result ? (JSON.parse(row.last_result) as CheckResult) : undefined);
      return (
        result ?? {
          id: row.id,
          label: row.label,
          status: "unknown",
          detail: "Waiting for the first run",
          observedAt: new Date(at).toISOString(),
        }
      );
    });
  }

  return { run, collect };
}

function register(ctx: ModuleContext): void {
  const store = createStore(ctx.db, ctx.orgId);
  const runner = createRunner(ctx, store);

  // Secrets are keyed by row id and cannot join the transaction, so the ids
  // are read before the rows go.
  let doomed: string[] = [];
  ctx.reset.add({
    scope: "checks",
    clear() {
      doomed = (
        ctx.db.prepare("SELECT id FROM checks_targets WHERE org_id = ?").all(ctx.orgId) as Array<{ id: string }>
      ).map((row) => row.id);
      return ctx.db.prepare("DELETE FROM checks_targets WHERE org_id = ?").run(ctx.orgId).changes;
    },
    async clearAfter() {
      let removed = 0;
      for (const id of doomed) {
        if (await ctx.secrets.has("checks", id)) {
          await ctx.secrets.delete("checks", id);
          removed++;
        }
      }
      return removed;
    },
  });

  ctx.health.addProvider({
    id: "checks",
    category: "checks",
    label: "HTTP and TCP checks",
    intervalMs: TICK_MS,
    collect: () => runner.collect(),
  });

  const toApi = async (row: CheckRow): Promise<CheckView> => toView(row, await ctx.secrets.has("checks", row.id));

  const view = async (id: string): Promise<CheckView> => {
    const row = store.get(id);
    if (!row) throw new HttpError(404, "No such check.");
    return toApi(row);
  };

  ctx.route("GET /api/checks", () => Promise.all(store.list().map(toApi)));

  ctx.route("POST /api/checks", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    const { fields, secret } = parseRequest(req.body);
    if (fields.authHeader && !secret) throw new HttpError(400, "secret: authHeader needs a value to send.");
    const id = `chk_${randomBytes(8).toString("hex")}`;
    if (secret) await ctx.secrets.put("checks", id, secret);
    store.insert(id, fields, new Date().toISOString());
    ctx.audit.record({ actor: user.id, action: "checks.create", target: id, detail: describe(fields) });
    return view(id);
  });

  ctx.route("PUT /api/checks/:id", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    const { id } = req.params;
    const existing = store.get(id);
    if (!existing) throw new HttpError(404, "No such check.");
    const { fields, secret } = parseRequest(req.body);
    const keepsSecret = secret === undefined && (await ctx.secrets.has("checks", id));
    if (fields.authHeader && !secret && !keepsSecret) {
      throw new HttpError(400, "secret: authHeader needs a value to send.");
    }
    if (!fields.authHeader || secret === "") await ctx.secrets.delete("checks", id);
    else if (secret) await ctx.secrets.put("checks", id, secret);
    const reset = fields.kind !== existing.kind || fields.target !== existing.target;
    store.update(id, fields, new Date().toISOString(), reset);
    const secretNote = secret === undefined ? "" : secret === "" ? "; secret removed" : "; secret replaced";
    ctx.audit.record({ actor: user.id, action: "checks.update", target: id, detail: describe(fields) + secretNote });
    return view(id);
  });

  ctx.route("DELETE /api/checks/:id", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    const { id } = req.params;
    const existing = store.get(id);
    if (!existing || !store.remove(id)) throw new HttpError(404, "No such check.");
    await ctx.secrets.delete("checks", id);
    ctx.audit.record({
      actor: user.id,
      action: "checks.delete",
      target: id,
      detail: `${existing.kind} ${existing.target}`,
    });
    return { ok: true };
  });

  ctx.route("POST /api/checks/:id/run", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    const row = store.get(req.params.id);
    if (!row) throw new HttpError(404, "No such check.");
    const result = await runner.run(row);
    ctx.audit.record({ actor: user.id, action: "checks.run", target: row.id, detail: result.status });
    return result;
  });
}

const mod: Module = {
  id: "checks",
  milestone: "A",
  migrations,
  register,
};

export default mod;

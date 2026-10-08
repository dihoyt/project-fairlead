import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Module, ModuleContext } from "../../contracts/module.js";
import type { ChannelRequest, ChannelView } from "../../contracts/notify.js";
import { HttpError } from "../../runtime/http.js";
import { SECRET_REQUIRED } from "./channels.js";
import { createEngine } from "./engine.js";
import { migrations } from "./migrations.js";
import { getChannelRow, listChannelRows, toView } from "./store.js";

const FLUSH_INTERVAL_MS = 10_000;

const httpUrl = (https: boolean) =>
  z
    .string()
    .trim()
    .max(2048)
    .refine(
      (value) => {
        try {
          const { protocol } = new URL(value);
          return https ? protocol === "https:" : protocol === "https:" || protocol === "http:";
        } catch {
          return false;
        }
      },
      `Must be an ${https ? "https" : "http(s)"} URL.`
    );

const channelRequest = z.object({
  kind: z.enum(["webhook", "ntfy", "discord"]),
  label: z.string().trim().min(1).max(100),
  enabled: z.boolean().optional(),
  minSeverity: z.enum(["warn", "crit"]).optional(),
  config: z
    .object({
      server: z.union([httpUrl(false), z.literal("")]).optional(),
      topic: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_-]{1,64}$/, "Topic: letters, digits, - and _, up to 64.")
        .optional(),
    })
    .optional(),
  secret: z.string().trim().max(2048).optional(),
});

function parseRequest(body: unknown): ChannelRequest {
  const parsed = channelRequest.safeParse(body ?? {});
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  const req = parsed.data;
  if (req.secret && (req.kind === "webhook" || req.kind === "discord")) {
    const url = httpUrl(req.kind === "discord").safeParse(req.secret);
    if (!url.success) throw new HttpError(400, `secret: ${url.error.issues[0]?.message ?? "invalid URL"}`);
  }
  return req;
}

function storedConfig(req: ChannelRequest): string {
  if (req.kind !== "ntfy") return "{}";
  const config: Record<string, string> = {};
  if (req.config?.server) config.server = req.config.server.replace(/\/+$/, "");
  if (req.config?.topic) config.topic = req.config.topic;
  return JSON.stringify(config);
}

function register(ctx: ModuleContext): void {
  const { db, orgId } = ctx;

  // Secrets are keyed by channel id and cannot join the transaction, so the
  // ids are read before the rows go.
  let doomed: string[] = [];
  ctx.reset.add({
    scope: "notifications",
    clear() {
      doomed = listChannelRows(db, orgId).map((row) => row.id);
      db.prepare("DELETE FROM notify_pending WHERE org_id = ?").run(orgId);
      db.prepare("DELETE FROM notify_sent WHERE org_id = ?").run(orgId);
      return db.prepare("DELETE FROM notify_channels WHERE org_id = ?").run(orgId).changes;
    },
    async clearAfter() {
      let removed = 0;
      for (const id of doomed) {
        if (await ctx.secrets.has("notify", id)) {
          await ctx.secrets.delete("notify", id);
          removed++;
        }
      }
      return removed;
    },
  });

  const debounce = ctx.settings.declare({
    key: "notify.debounceSeconds",
    label: "Hold a change for (seconds)",
    help: "A health change is sent once it has held this long; a check that flaps back inside it sends nothing.",
    schema: z.number().int().min(0).max(3600),
    default: 90,
    env: "NOTIFY_DEBOUNCE_SECONDS",
  });
  const maxHold = ctx.settings.declare({
    key: "notify.maxHoldSeconds",
    label: "Longest hold for a flapping check (seconds)",
    help: "A check that keeps changing is sent with its current status after this long, at most once per period.",
    schema: z.number().int().min(0).max(86_400),
    default: 900,
    env: "NOTIFY_MAX_HOLD_SECONDS",
  });

  const engine = createEngine({
    db,
    orgId,
    secrets: ctx.secrets,
    log: ctx.log,
    timing: () => ({ debounceMs: debounce.get() * 1000, maxHoldMs: maxHold.get() * 1000 }),
  });

  ctx.bus.on("health.changed", (change) => engine.record(change));
  ctx.scheduler.every("notify.flush", FLUSH_INTERVAL_MS, (signal) => engine.flush(signal), { timeoutMs: 60_000 });

  const view = async (id: string): Promise<ChannelView> => {
    const row = getChannelRow(db, orgId, id);
    if (!row) throw new HttpError(404, "No such channel.");
    return toView(row, await ctx.secrets.has("notify", id));
  };

  ctx.route("GET /api/notify/channels", async () =>
    Promise.all(listChannelRows(db, orgId).map(async (row) => toView(row, await ctx.secrets.has("notify", row.id))))
  );

  ctx.route("POST /api/notify/channels", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    const body = parseRequest(req.body);
    if (SECRET_REQUIRED[body.kind] && !body.secret) {
      throw new HttpError(400, `secret: a ${body.kind} channel needs its URL.`);
    }
    if (body.kind === "ntfy" && !body.config?.topic) throw new HttpError(400, "config.topic: required for ntfy.");
    const id = `ch_${randomBytes(8).toString("hex")}`;
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO notify_channels (id, org_id, kind, label, enabled, min_severity, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      orgId,
      body.kind,
      body.label,
      body.enabled === false ? 0 : 1,
      body.minSeverity ?? "warn",
      storedConfig(body),
      at,
      at
    );
    if (body.secret) await ctx.secrets.put("notify", id, body.secret);
    ctx.audit.record({ actor: user.id, action: "notify.create", target: id, detail: `${body.kind} "${body.label}"` });
    return view(id);
  });

  ctx.route("PUT /api/notify/channels/:id", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    const { id } = req.params;
    const existing = getChannelRow(db, orgId, id);
    if (!existing) throw new HttpError(404, "No such channel.");
    const body = parseRequest(req.body);
    if (body.kind !== existing.kind) {
      throw new HttpError(400, "kind: a channel's kind cannot change; create a new channel instead.");
    }
    // Omitted keeps the stored secret; an empty string clears it.
    if (body.secret === "" && SECRET_REQUIRED[body.kind]) {
      throw new HttpError(400, `secret: a ${body.kind} channel needs its URL.`);
    }
    if (body.kind === "ntfy" && !body.config?.topic) throw new HttpError(400, "config.topic: required for ntfy.");
    db.prepare(
      `UPDATE notify_channels SET label = ?, enabled = ?, min_severity = ?, config = ?, updated_at = ?
       WHERE org_id = ? AND id = ?`
    ).run(
      body.label,
      body.enabled === undefined ? existing.enabled : body.enabled ? 1 : 0,
      body.minSeverity ?? existing.min_severity,
      storedConfig(body),
      new Date().toISOString(),
      orgId,
      id
    );
    if (body.secret === "") await ctx.secrets.delete("notify", id);
    else if (body.secret !== undefined) await ctx.secrets.put("notify", id, body.secret);
    ctx.audit.record({
      actor: user.id,
      action: "notify.update",
      target: id,
      detail: `${body.kind} "${body.label}"${body.secret === undefined ? "" : " (secret changed)"}`,
    });
    return view(id);
  });

  ctx.route("DELETE /api/notify/channels/:id", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    const { id } = req.params;
    const existing = getChannelRow(db, orgId, id);
    if (!existing) throw new HttpError(404, "No such channel.");
    db.transaction(() => {
      db.prepare("DELETE FROM notify_sent WHERE org_id = ? AND channel_id = ?").run(orgId, id);
      db.prepare("DELETE FROM notify_channels WHERE org_id = ? AND id = ?").run(orgId, id);
    })();
    await ctx.secrets.delete("notify", id);
    ctx.audit.record({
      actor: user.id,
      action: "notify.delete",
      target: id,
      detail: `${existing.kind} "${existing.label}"`,
    });
    return { ok: true as const };
  });

  ctx.route("POST /api/notify/channels/:id/test", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    const result = await engine.test(req.params.id);
    if (!result) throw new HttpError(404, "No such channel.");
    ctx.audit.record({
      actor: user.id,
      action: "notify.test",
      target: req.params.id,
      result: result.ok ? "ok" : "error",
      ...(result.error ? { detail: result.error } : {}),
    });
    return result;
  });
}

const mod: Module = {
  id: "notify",
  milestone: "A",
  migrations,
  register,
};

export default mod;

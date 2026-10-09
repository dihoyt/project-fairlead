import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Module, ModuleContext } from "../../contracts/module.js";
import {
  EMAIL_PRESETS,
  type ChannelRequest,
  type ChannelView,
  type EmailConfig,
  type EmailPreset,
  type EmailSetupView,
} from "../../contracts/notify.js";
import { HttpError } from "../../runtime/http.js";
import { SECRET_REQUIRED } from "./channels.js";
import {
  OAUTH_ENDPOINTS,
  OAUTH_SCOPES,
  accountOf,
  emailMode,
  providerOf,
  tokenRequest,
  type OAuthEndpoints,
} from "./email.js";
import { createEngine } from "./engine.js";
import { OAUTH_SCOPE, createMailer } from "./mailer.js";
import { migrations } from "./migrations.js";
import { getChannelRow, listChannelRows, parseConfig, toView } from "./store.js";

export interface NotifyModuleOptions {
  // Tests point these at a fake Google / Microsoft.
  endpoints?: OAuthEndpoints;
}

const CALLBACK_PATH = "/api/notify/oauth/callback";
const STATE_TTL_MS = 10 * 60_000;
const GOOGLE_ISSUER = "https://accounts.google.com";
const MICROSOFT_COMMON_ISSUER = "https://login.microsoftonline.com/common/v2.0";

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

const address = z.string().trim().max(254).email("Must be an email address.");

const emailConfig = z.object({
  preset: z.enum(Object.keys(EMAIL_PRESETS) as [EmailPreset, ...EmailPreset[]]),
  host: z
    .string()
    .trim()
    .max(253)
    .regex(/^[A-Za-z0-9.-]*$/, "Host: a hostname or IP address.")
    .optional(),
  port: z.number().int().min(1).max(65535).optional(),
  security: z.enum(["starttls", "tls", "none"]).optional(),
  username: z.string().trim().max(254).optional(),
  clientId: z.string().trim().max(200).optional(),
  from: z.union([address, z.literal("")]).optional(),
  to: z.array(address).min(1, "At least one recipient.").max(20),
});

const channelRequest = z.object({
  kind: z.enum(["webhook", "ntfy", "discord", "email"]),
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
      email: emailConfig.optional(),
    })
    .optional(),
  secret: z.string().trim().max(4096).optional(),
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
  if (req.kind === "email") emailProblem(req.config?.email);
  return req as ChannelRequest;
}

function emailProblem(email: EmailConfig | undefined): void {
  if (!email) throw new HttpError(400, "config.email: required for email.");
  const mode = emailMode(email);
  if (mode === "smtp" && !email.host) throw new HttpError(400, "config.email.host: required for SMTP.");
  if (mode === "oauth" && !email.clientId) throw new HttpError(400, "config.email.clientId: required to sign in.");
  if (mode !== "oauth" && !email.from) throw new HttpError(400, "config.email.from: required.");
}

// What is kept of an email config: the fields its mode uses, plus the
// signed-in account while the client stays the same.
function storedEmail(email: EmailConfig, previous?: { clientId?: string; preset?: EmailPreset; account?: string }) {
  const mode = emailMode(email);
  const out: Record<string, unknown> = { preset: email.preset, to: [...new Set(email.to)] };
  if (email.from) out.from = email.from;
  if (mode === "smtp") {
    const preset = EMAIL_PRESETS[email.preset];
    out.host = email.host;
    out.port = email.port ?? preset.port ?? 587;
    out.security = email.security ?? preset.security ?? "starttls";
    if (email.username) out.username = email.username;
  }
  if (mode === "oauth") {
    out.clientId = email.clientId;
    if (previous?.account && sameClient(email, previous)) out.account = previous.account;
  }
  return out;
}

const sameClient = (a: { clientId?: string; preset?: EmailPreset }, b: { clientId?: string; preset?: EmailPreset }) =>
  a.clientId === b.clientId && a.preset === b.preset;

function storedConfig(req: ChannelRequest, previous?: string): string {
  if (req.kind === "email") {
    return JSON.stringify({
      email: storedEmail(req.config!.email!, previous ? parseConfig(previous).email : undefined),
    });
  }
  if (req.kind !== "ntfy") return "{}";
  const config: Record<string, string> = {};
  if (req.config?.server) config.server = req.config.server.replace(/\/+$/, "");
  if (req.config?.topic) config.topic = req.config.topic;
  return JSON.stringify(config);
}

const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export function register(ctx: ModuleContext, options: NotifyModuleOptions = {}): void {
  const { db, orgId } = ctx;
  const endpoints = options.endpoints ?? OAUTH_ENDPOINTS;
  const origin = () => (ctx.services.has("gate") ? ctx.services.get("gate").readiness().signInUrl : "");
  const redirectUri = () => (origin() ? `${origin()}${CALLBACK_PATH}` : "");

  // Secrets are keyed by channel id and cannot join the transaction, so the
  // ids are read before the rows go.
  let doomed: string[] = [];
  ctx.reset.add({
    scope: "notifications",
    clear() {
      doomed = listChannelRows(db, orgId).map((row) => row.id);
      db.prepare("DELETE FROM notify_pending WHERE org_id = ?").run(orgId);
      db.prepare("DELETE FROM notify_sent WHERE org_id = ?").run(orgId);
      db.prepare("DELETE FROM notify_oauth_states WHERE org_id = ?").run(orgId);
      return db.prepare("DELETE FROM notify_channels WHERE org_id = ?").run(orgId).changes;
    },
    async clearAfter() {
      let removed = 0;
      for (const id of doomed) {
        for (const scope of ["notify", OAUTH_SCOPE]) {
          if (await ctx.secrets.has(scope, id)) {
            await ctx.secrets.delete(scope, id);
            removed++;
          }
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

  const mailer = createMailer({
    secrets: ctx.secrets,
    endpoints,
    entra: () => (ctx.services.has("entraMail") ? ctx.services.get("entraMail") : undefined),
    consoleUrl: origin,
  });

  const engine = createEngine({
    db,
    orgId,
    secrets: ctx.secrets,
    log: ctx.log,
    timing: () => ({ debounceMs: debounce.get() * 1000, maxHoldMs: maxHold.get() * 1000 }),
    mailer,
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
    if (body.kind === "email" && !body.secret) {
      const email = body.config!.email!;
      if (emailMode(email) === "oauth") throw new HttpError(400, "secret: the OAuth client secret is required.");
      if (emailMode(email) === "smtp" && email.username) {
        throw new HttpError(400, "secret: the SMTP password is required with a username.");
      }
    }
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
      storedConfig(body, existing.config),
      new Date().toISOString(),
      orgId,
      id
    );
    if (body.secret === "") await ctx.secrets.delete("notify", id);
    else if (body.secret !== undefined) await ctx.secrets.put("notify", id, body.secret);
    if (body.kind === "email") {
      const before = parseConfig(existing.config).email;
      // A different client, or a mode without sign-in, can't use the old sign-in.
      if (!before || !sameClient(body.config!.email!, before) || emailMode(body.config!.email!) !== "oauth") {
        await ctx.secrets.delete(OAUTH_SCOPE, id);
      }
      mailer.forget(id);
    }
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
    await ctx.secrets.delete(OAUTH_SCOPE, id);
    mailer.forget(id);
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

  ctx.route("GET /api/notify/email/setup", async () => {
    const setup: EmailSetupView = {
      redirectUri: redirectUri(),
      entra: ctx.services.has("entraMail")
        ? await ctx.services.get("entraMail").status()
        : { ready: false, reason: "The Microsoft Entra ID connector is not loaded." },
    };
    if (!setup.redirectUri) {
      setup.oauthBlocked = "Set the console's public URL first (Admin > Settings), so the provider can send you back.";
    }
    if (ctx.services.has("signin")) {
      const oidc = await ctx.services.get("signin").oidc();
      const issuer = oidc.issuer.replace(/\/+$/, "");
      if (oidc.clientId && issuer === GOOGLE_ISSUER) {
        setup.signInClient = { provider: "google", clientId: oidc.clientId };
      }
      if (oidc.clientId && issuer === MICROSOFT_COMMON_ISSUER) {
        setup.signInClient = { provider: "microsoft", clientId: oidc.clientId };
      }
    }
    return setup;
  });

  ctx.route("POST /api/notify/channels/:id/oauth", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    const { id } = req.params;
    const row = getChannelRow(db, orgId, id);
    if (!row) throw new HttpError(404, "No such channel.");
    const email = parseConfig(row.config).email;
    if (row.kind !== "email" || !email || emailMode(email) !== "oauth") {
      throw new HttpError(400, "Only an email channel with a sign-in preset signs in.");
    }
    if (!email.clientId) throw new HttpError(400, "The channel has no OAuth client id.");
    if (!(await ctx.secrets.has("notify", id))) throw new HttpError(400, "The channel has no OAuth client secret.");
    const redirect = redirectUri();
    if (!redirect) {
      throw new HttpError(
        409,
        "Set the console's public URL first (Admin > Settings), so the provider can send you back."
      );
    }
    const provider = providerOf(email);
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const at = Date.now();
    db.prepare("DELETE FROM notify_oauth_states WHERE org_id = ? AND created_at < ?").run(orgId, at - STATE_TTL_MS);
    db.prepare(
      "INSERT INTO notify_oauth_states (org_id, state, channel_id, user_id, verifier, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(orgId, state, id, user.id, verifier, at);
    const url = new URL(endpoints[provider].authorize);
    url.search = new URLSearchParams({
      client_id: email.clientId,
      redirect_uri: redirect,
      response_type: "code",
      scope: OAUTH_SCOPES[provider],
      state,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      // Google sends a refresh token only with offline access and, after the
      // first time, only when consent is asked again.
      ...(provider === "google" ? { access_type: "offline", prompt: "consent" } : { prompt: "select_account" }),
      ...(email.from ? { login_hint: email.from } : {}),
    }).toString();
    return { url: url.toString() };
  });

  ctx.route("GET /api/notify/oauth/callback", async (req, res) => {
    const back = (channelId: string, outcome: Record<string, string>) => {
      const query = new URLSearchParams({ ...(channelId ? { channel: channelId } : {}), ...outcome }).toString();
      res.redirect(303, `${origin() || ""}/#/notifications?${query}`);
      return undefined;
    };
    const fail = (channelId: string, message: string) =>
      back(channelId, { oauth: "error", message: message.slice(0, 300) });

    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    const { state, code, error, error_description: description } = req.query;
    const row = state
      ? (db
          .prepare(
            "SELECT channel_id, user_id, verifier, created_at FROM notify_oauth_states WHERE org_id = ? AND state = ?"
          )
          .get(orgId, String(state)) as
          { channel_id: string; user_id: string; verifier: string; created_at: number } | undefined)
      : undefined;
    if (!row) return fail("", "The sign-in expired or was already used. Start it again from the channel.");
    db.prepare("DELETE FROM notify_oauth_states WHERE org_id = ? AND state = ?").run(orgId, String(state));
    const channelId = row.channel_id;
    if (row.user_id !== user.id) return fail(channelId, "The sign-in was started by someone else.");
    if (row.created_at < Date.now() - STATE_TTL_MS) return fail(channelId, "The sign-in expired. Start it again.");
    if (error) return fail(channelId, `${String(error)}${description ? `: ${String(description)}` : ""}`);
    if (!code) return fail(channelId, "The provider sent no authorization code.");

    const channel = getChannelRow(db, orgId, channelId);
    const email = channel ? parseConfig(channel.config).email : undefined;
    if (!channel || !email || emailMode(email) !== "oauth" || !email.clientId) {
      return fail(channelId, "The channel changed while signing in.");
    }
    const clientSecret = await ctx.secrets.get("notify", channelId);
    if (!clientSecret) return fail(channelId, "The channel has no OAuth client secret.");
    const provider = providerOf(email);
    try {
      const tokens = await tokenRequest(
        provider,
        {
          grant_type: "authorization_code",
          code: String(code),
          redirect_uri: redirectUri(),
          client_id: email.clientId,
          client_secret: clientSecret,
          code_verifier: row.verifier,
        },
        endpoints
      );
      if (!tokens.refreshToken) {
        return fail(channelId, "The provider returned no refresh token, so mail could only be sent for an hour.");
      }
      const account = accountOf(tokens.idToken);
      await ctx.secrets.put(OAUTH_SCOPE, channelId, tokens.refreshToken);
      mailer.forget(channelId);
      const stored = JSON.parse(channel.config) as { email: Record<string, unknown> };
      if (account) stored.email.account = account;
      else delete stored.email.account;
      db.prepare("UPDATE notify_channels SET config = ?, updated_at = ? WHERE org_id = ? AND id = ?").run(
        JSON.stringify(stored),
        new Date().toISOString(),
        orgId,
        channelId
      );
      ctx.audit.record({
        actor: user.id,
        action: "notify.oauth",
        target: channelId,
        detail: `${provider} sign-in${account ? ` as ${account}` : ""}`,
      });
      return back(channelId, { oauth: "ok" });
    } catch (err) {
      ctx.audit.record({ actor: user.id, action: "notify.oauth", target: channelId, result: "error" });
      return fail(channelId, err instanceof Error ? err.message : String(err));
    }
  });
}

const mod: Module = {
  id: "notify",
  milestone: "A",
  migrations,
  register: (ctx) => register(ctx),
};

export default mod;

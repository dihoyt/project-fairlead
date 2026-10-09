import nodemailer from "nodemailer";
import type { Status } from "../../contracts/health.js";
import {
  EMAIL_PRESETS,
  type EmailConfig,
  type EmailConfigView,
  type EmailMessage,
  type EmailOAuthProvider,
  type EntraMailService,
  type WebhookPayload,
} from "../../contracts/notify.js";
import { title } from "./channels.js";

const TIMEOUT_MS = 20_000;

export interface OAuthEndpoints {
  google: { authorize: string; token: string; send: string };
  microsoft: { authorize: string; token: string; send: string };
}

export const OAUTH_ENDPOINTS: OAuthEndpoints = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    send: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
  },
  microsoft: {
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    send: "https://graph.microsoft.com/v1.0/me/sendMail",
  },
};

// openid + email give the id_token the signed-in address comes from;
// offline_access (Microsoft) and access_type=offline (Google) the refresh token.
export const OAUTH_SCOPES: Record<EmailOAuthProvider, string> = {
  google: "openid email https://www.googleapis.com/auth/gmail.send",
  microsoft: "openid email offline_access https://graph.microsoft.com/Mail.Send",
};

export class SendError extends Error {
  readonly status?: number;
  readonly response?: string;
  constructor(message: string, status?: number, response?: string) {
    super(message);
    this.status = status;
    this.response = response;
  }
}

export interface SendResult {
  // SMTP reply code or HTTP status.
  status?: number;
  response?: string;
}

const STATUS_COLOR: Record<Status, string> = {
  crit: "#e03131",
  warn: "#f59f00",
  ok: "#2f9e44",
  unknown: "#868e96",
  absent: "#868e96",
};

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function compose(p: WebhookPayload, to: string[], consoleUrl: string): EmailMessage {
  const subject = title(p)
    .replace(/[\r\n]+/g, " ")
    .slice(0, 200);
  const lines = [p.label, "", p.detail, "", `${p.from} → ${p.to} at ${p.at}`, `${p.providerId} / ${p.checkId}`];
  if (consoleUrl) lines.push("", consoleUrl);
  const link = consoleUrl ? `<p><a href="${escapeHtml(consoleUrl)}">Open ${escapeHtml(p.source)}</a></p>` : "";
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:14px;color:#222">
<p><span style="display:inline-block;padding:2px 8px;border-radius:3px;color:#fff;background:${STATUS_COLOR[p.to]}">${escapeHtml(p.to.toUpperCase())}</span>
<strong>${escapeHtml(p.label)}</strong></p>
<p style="white-space:pre-wrap">${escapeHtml(p.detail)}</p>
<p style="color:#666">${escapeHtml(p.from)} → ${escapeHtml(p.to)} at ${escapeHtml(p.at)}<br>${escapeHtml(p.providerId)} / ${escapeHtml(p.checkId)}</p>
${link}</body></html>`;
  return { to, subject, text: lines.join("\n"), html };
}

export function redact(message: string, secrets: Array<string | null | undefined>): string {
  let out = message;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  return out;
}

export function emailMode(config: EmailConfig) {
  return EMAIL_PRESETS[config.preset].mode;
}

export function providerOf(config: EmailConfig): EmailOAuthProvider {
  return EMAIL_PRESETS[config.preset].provider ?? "google";
}

// The sender for a message: the configured From, else (oauth) the account.
export function sender(config: EmailConfigView): string {
  return config.from || config.account || "";
}

export async function sendSmtp(
  config: EmailConfig,
  password: string | null,
  from: string,
  message: EmailMessage
): Promise<SendResult> {
  const security = config.security ?? "starttls";
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port ?? (security === "tls" ? 465 : 587),
    secure: security === "tls",
    requireTLS: security === "starttls",
    ignoreTLS: security === "none",
    ...(config.username ? { auth: { user: config.username, pass: password ?? "" } } : {}),
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
  try {
    const info = await transport.sendMail({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { status: 250, response: info.response };
  } catch (err) {
    const e = err as { message?: string; response?: string; responseCode?: number; code?: string };
    const what = e.responseCode ? `SMTP ${e.responseCode}` : (e.code ?? "SMTP error");
    throw new SendError(`${what}: ${e.message ?? String(err)}`, e.responseCode, e.response);
  } finally {
    transport.close();
  }
}

// A complete MIME message (text and HTML parts) as nodemailer builds it.
async function mime(from: string, message: EmailMessage): Promise<Buffer> {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "\r\n" });
  const info = await transport.sendMail({
    from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
  return info.message as Buffer;
}

async function providerError(res: Response, what: string): Promise<SendError> {
  const text = (await res.text().catch(() => "")).slice(0, 500);
  let detail = "";
  try {
    const body = JSON.parse(text) as {
      error?: string | { code?: string | number; message?: string };
      error_description?: string;
    };
    if (typeof body.error === "string")
      detail = body.error_description ? `${body.error}: ${body.error_description}` : body.error;
    else if (body.error) detail = body.error.message ?? String(body.error.code ?? "");
  } catch {
    // Not JSON: the status and body say enough.
  }
  return new SendError(
    `${what} answered ${res.status}${detail ? `: ${detail.split(/\r?\n/)[0]}` : ""}`,
    res.status,
    text
  );
}

const timeout = (signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);

export interface TokenSet {
  accessToken: string;
  // Microsoft rotates refresh tokens; Google usually returns none on refresh.
  refreshToken?: string;
  idToken?: string;
}

export async function tokenRequest(
  provider: EmailOAuthProvider,
  params: Record<string, string>,
  endpoints: OAuthEndpoints,
  signal?: AbortSignal
): Promise<TokenSet> {
  const res = await fetch(endpoints[provider].token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params),
    redirect: "error",
    signal: timeout(signal),
  });
  if (!res.ok) throw await providerError(res, provider === "google" ? "Google sign-in" : "Microsoft sign-in");
  const body = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
  if (!body.access_token) throw new SendError("The sign-in returned no access token.");
  return {
    accessToken: body.access_token,
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    ...(body.id_token ? { idToken: body.id_token } : {}),
  };
}

// The address in an id_token straight from the token endpoint over TLS, so
// its signature need not be checked (OIDC Core 3.1.3.7).
export function accountOf(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      email?: unknown;
      preferred_username?: unknown;
    };
    const value = typeof claims.email === "string" ? claims.email : claims.preferred_username;
    return typeof value === "string" && value.includes("@") ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function sendOAuth(
  provider: EmailOAuthProvider,
  accessToken: string,
  from: string,
  message: EmailMessage,
  endpoints: OAuthEndpoints,
  signal?: AbortSignal
): Promise<SendResult> {
  const raw = await mime(from, message);
  // Gmail takes the MIME message base64url in JSON; Graph takes it base64
  // as text/plain, which keeps the plain-text part Graph's JSON form drops.
  const res =
    provider === "google"
      ? await fetch(endpoints.google.send, {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ raw: raw.toString("base64url") }),
          redirect: "error",
          signal: timeout(signal),
        })
      : await fetch(endpoints.microsoft.send, {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "text/plain" },
          body: raw.toString("base64"),
          redirect: "error",
          signal: timeout(signal),
        });
  if (!res.ok) throw await providerError(res, provider === "google" ? "Gmail" : "Microsoft Graph");
  return { status: res.status };
}

export async function sendEntra(
  service: EntraMailService,
  from: string,
  message: EmailMessage,
  signal?: AbortSignal
): Promise<SendResult> {
  try {
    await service.sendMail(from, message, signal);
    return { status: 202 };
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    throw new SendError(
      err instanceof Error ? err.message : String(err),
      typeof status === "number" ? status : undefined
    );
  }
}

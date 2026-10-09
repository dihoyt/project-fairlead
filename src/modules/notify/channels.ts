import type { Status } from "../../contracts/health.js";
import type { ChannelKind, WebhookPayload } from "../../contracts/notify.js";
import { product } from "../../product.js";

const TIMEOUT_MS = 10_000;
export const DEFAULT_NTFY_SERVER = "https://ntfy.sh";

export interface Delivery {
  kind: ChannelKind;
  config: { server?: string; topic?: string };
  secret: string | null;
  payload: WebhookPayload;
}

export interface DeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
}

// Whether a kind cannot work without its secret: for these the secret is the
// destination URL itself, which may embed a token.
export const SECRET_REQUIRED: Record<ChannelKind, boolean> = {
  webhook: true,
  discord: true,
  ntfy: false,
  email: false,
};

const DISCORD_COLOR: Record<Status, number> = {
  crit: 0xe03131,
  warn: 0xf59f00,
  ok: 0x2f9e44,
  unknown: 0x868e96,
  absent: 0x868e96,
};

const NTFY_PRIORITY: Record<Status, number> = { crit: 5, warn: 4, ok: 3, unknown: 3, absent: 2 };
const NTFY_TAG: Record<Status, string> = {
  crit: "rotating_light",
  warn: "warning",
  ok: "white_check_mark",
  unknown: "grey_question",
  absent: "heavy_minus_sign",
};

export function title(p: WebhookPayload): string {
  return `[${p.to.toUpperCase()}] ${p.label}`;
}

function body(p: WebhookPayload): string {
  return `${p.detail}\n(${p.from} → ${p.to})`;
}

function request(d: Delivery): { url: string; headers: Record<string, string>; json: unknown } {
  const p = d.payload;
  switch (d.kind) {
    case "email":
      throw new Error("Email is not sent over a webhook.");
    case "webhook":
      return { url: d.secret ?? "", headers: {}, json: p };
    case "discord":
      return {
        url: d.secret ?? "",
        headers: {},
        json: {
          username: product.displayName,
          allowed_mentions: { parse: [] },
          embeds: [
            {
              title: title(p).slice(0, 256),
              description: body(p).slice(0, 4000),
              color: DISCORD_COLOR[p.to],
              timestamp: p.at,
              footer: { text: `${p.providerId} / ${p.checkId}`.slice(0, 2048) },
            },
          ],
        },
      };
    case "ntfy": {
      // JSON publishing at the server root keeps label and detail out of
      // HTTP headers, which cannot carry arbitrary text.
      const server = (d.config.server || DEFAULT_NTFY_SERVER).replace(/\/+$/, "");
      return {
        url: `${server}/`,
        headers: d.secret ? { Authorization: `Bearer ${d.secret}` } : {},
        json: {
          topic: d.config.topic,
          title: title(p),
          message: body(p),
          priority: NTFY_PRIORITY[p.to],
          tags: [NTFY_TAG[p.to]],
        },
      };
    }
  }
}

// The secret may be the URL itself, so it is scrubbed from anything that
// ends up in lastError or a test-send response.
function redact(message: string, secret: string | null): string {
  return secret ? message.split(secret).join("[redacted]") : message;
}

export async function deliver(d: Delivery, signal?: AbortSignal): Promise<DeliveryResult> {
  if (SECRET_REQUIRED[d.kind] && !d.secret) return { ok: false, error: "No URL is stored for this channel." };
  if (d.kind === "ntfy" && !d.config.topic) return { ok: false, error: "No ntfy topic is set." };
  if (d.kind === "email") return { ok: false, error: "Email channels are not available in this build." };
  const { url, headers, json } = request(d);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(json),
      // A redirect would carry the body, and for ntfy the token, somewhere
      // nobody configured.
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (res.ok) return { ok: true, status: res.status };
    const text = (await res.text().catch(() => "")).slice(0, 300);
    return { ok: false, status: res.status, error: redact(`HTTP ${res.status}${text ? `: ${text}` : ""}`, d.secret) };
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause?.message;
    const message = err instanceof Error ? (cause ? `${err.message}: ${cause}` : err.message) : String(err);
    return { ok: false, error: redact(message, d.secret) };
  }
}

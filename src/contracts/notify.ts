import type { Status } from "./health.js";

export type ChannelKind = "webhook" | "ntfy" | "discord";

export interface ChannelView {
  id: string;
  kind: ChannelKind;
  label: string;
  enabled: boolean;
  // Changes into a status at or above this are sent; recoveries to "ok" are
  // sent for anything that was sent going down.
  minSeverity: "warn" | "crit";
  // Non-secret settings: ntfy server and topic, webhook method. Secret parts
  // (Discord webhook URL, ntfy token, webhook URL with a token in it) are
  // stored through ctx.secrets and never returned.
  config: { server?: string; topic?: string };
  hasSecret: boolean;
  lastSentAt?: string;
  lastError?: string;
}

export interface ChannelRequest {
  kind: ChannelKind;
  label: string;
  enabled?: boolean;
  minSeverity?: "warn" | "crit";
  config?: { server?: string; topic?: string };
  // Write-only. Omitted on update: keep the stored one.
  secret?: string;
}

export interface TestSendResult {
  ok: boolean;
  status?: number;
  error?: string;
}

// The body a "webhook" channel POSTs.
export interface WebhookPayload {
  source: string;
  providerId: string;
  checkId: string;
  label: string;
  from: Status;
  to: Status;
  detail: string;
  at: string;
}

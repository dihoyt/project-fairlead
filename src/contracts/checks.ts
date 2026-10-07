import type { CheckResult } from "./health.js";

export type CheckKind = "http" | "tcp";

export interface CheckView {
  id: string;
  label: string;
  kind: CheckKind;
  // http: a URL; tcp: "host:port".
  target: string;
  intervalMs: number;
  timeoutMs: number;
  // http only. Default: any 2xx or 3xx.
  expectStatus?: number[];
  // http only. A plain, case-sensitive substring the response body must
  // contain, not a regex: a pattern from the UI is never run against a body,
  // so a bad one cannot hang the checker.
  bodyMatch?: string;
  // http only. Header carrying the stored secret, e.g. "Authorization" or
  // "X-API-Key". The value is stored through ctx.secrets and never returned.
  authHeader?: string;
  // Absent reads as false.
  hasSecret?: boolean;
  // https only. Accept a self-signed or otherwise unverifiable certificate.
  // Off unless set on the check (absent reads as false); the UI flags a
  // check that has it on.
  insecureSkipVerify?: boolean;
  // TLS expiry warning threshold in days (https targets). Crit at a third of it.
  tlsWarnDays: number;
  enabled: boolean;
  last?: CheckResult;
}

export interface CheckRequest {
  label: string;
  kind: CheckKind;
  target: string;
  intervalMs?: number;
  timeoutMs?: number;
  expectStatus?: number[];
  bodyMatch?: string;
  authHeader?: string;
  // Write-only: the auth header's value. Omitted on update: keep the stored
  // one; an empty string removes it.
  secret?: string;
  // Default false.
  insecureSkipVerify?: boolean;
  tlsWarnDays?: number;
  enabled?: boolean;
}

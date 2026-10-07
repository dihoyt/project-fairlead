import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { TLSSocket } from "node:tls";
import type { CheckView } from "../../contracts/checks.js";
import type { CheckResult } from "../../contracts/health.js";

const DAY_MS = 86_400_000;

export type CheckSpec = Omit<CheckView, "last" | "hasSecret">;

export interface Certificate {
  subject: string;
  issuer: string;
  validTo: string;
  daysLeft: number;
}

export interface ProbeOutcome {
  // Time to the response headers (http) or to the connection (tcp).
  latencyMs?: number;
  httpStatus?: number;
  headers?: Record<string, string>;
  certificate?: Certificate;
  // Set only when the check has bodyMatch.
  bodyMatched?: boolean;
  bodyExcerpt?: string;
  bodyTruncated?: boolean;
  // "body": the headers arrived but reading the body failed.
  error?: { message: string; code?: string; during?: "body" };
}

export function parseHostPort(target: string): { host: string; port: number } | null {
  const match = /^(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9.-]+)):(\d{1,5})$/.exec(target.trim());
  if (!match) return null;
  const port = Number(match[3]);
  if (port < 1 || port > 65_535) return null;
  return { host: (match[1] ?? match[2])!, port };
}

function describeError(err: unknown, timeoutMs: number): { message: string; code?: string } {
  const e = err as NodeJS.ErrnoException;
  if (e?.name === "AbortError" || e?.name === "TimeoutError" || e?.code === "ETIMEDOUT") {
    return { message: `timed out after ${timeoutMs} ms`, code: "ETIMEDOUT" };
  }
  const message = e?.message || String(err);
  return e?.code ? { message, code: e.code } : { message };
}

function joined(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(", ") : (value ?? "");
}

function certificateOf(socket: TLSSocket, now: number): Certificate | undefined {
  const cert = socket.getPeerCertificate?.();
  if (!cert?.valid_to) return undefined;
  const validTo = new Date(cert.valid_to);
  return {
    subject: joined(cert.subject?.CN),
    issuer: joined(cert.issuer?.CN ?? cert.issuer?.O),
    validTo: validTo.toISOString(),
    daysLeft: Math.floor((validTo.getTime() - now) / DAY_MS),
  };
}

// Only the headers that help explain a failure; cookies and the like stay out of results.
const KEPT_HEADERS = ["content-type", "location", "server", "www-authenticate", "retry-after"];

// Enough for a health endpoint or a login page; a match past it reads as absent.
export const MAX_BODY_BYTES = 1 << 20;
const BODY_EXCERPT_CHARS = 500;

function probeHttp(spec: CheckSpec, now: () => number, options: ProbeOptions): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const url = new URL(spec.target);
    const lib = url.protocol === "https:" ? https : http;
    const started = performance.now();
    let settled = false;
    const finish = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const headers: Record<string, string> = {};
    if (spec.authHeader && options.secret) headers[spec.authHeader] = options.secret;
    // A fresh connection every time (agent: false), so the handshake and its
    // certificate are part of every probe rather than hidden by keep-alive.
    const req = lib.request(
      url,
      {
        method: "GET",
        agent: false,
        headers,
        signal: AbortSignal.timeout(spec.timeoutMs),
        rejectUnauthorized: !spec.insecureSkipVerify,
        ...(options.ca ? { ca: options.ca } : {}),
      },
      (res) => {
        const latencyMs = Math.round(performance.now() - started);
        const kept: Record<string, string> = {};
        for (const name of KEPT_HEADERS) {
          const value = res.headers[name];
          if (value !== undefined) kept[name] = Array.isArray(value) ? value.join(", ") : value;
        }
        const certificate = url.protocol === "https:" ? certificateOf(res.socket as TLSSocket, now()) : undefined;
        const outcome: ProbeOutcome = {
          latencyMs,
          httpStatus: res.statusCode ?? 0,
          headers: kept,
          ...(certificate ? { certificate } : {}),
        };
        const match = spec.bodyMatch;
        if (!match) {
          finish(outcome);
          res.destroy();
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        const judgeBody = (truncated: boolean) => {
          const body = Buffer.concat(chunks).toString("utf8");
          const found = body.includes(match);
          finish({
            ...outcome,
            bodyMatched: found,
            ...(found ? {} : { bodyExcerpt: body.slice(0, BODY_EXCERPT_CHARS), bodyTruncated: truncated }),
          });
          res.destroy();
        };
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size >= MAX_BODY_BYTES) judgeBody(true);
        });
        res.on("end", () => judgeBody(false));
        res.on("error", (err) =>
          finish({ ...outcome, error: { ...describeError(err, spec.timeoutMs), during: "body" } })
        );
      }
    );
    req.on("error", (err) => finish({ error: describeError(err, spec.timeoutMs) }));
    req.end();
  });
}

function probeTcp(spec: CheckSpec): Promise<ProbeOutcome> {
  const target = parseHostPort(spec.target);
  if (!target) return Promise.resolve({ error: { message: `"${spec.target}" is not host:port` } });
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = net.connect({ ...target, signal: AbortSignal.timeout(spec.timeoutMs) });
    socket.once("connect", () => {
      const latencyMs = Math.round(performance.now() - started);
      socket.destroy();
      resolve({ latencyMs });
    });
    socket.once("error", (err) => {
      socket.destroy();
      resolve({ error: describeError(err, spec.timeoutMs) });
    });
  });
}

export interface ProbeOptions {
  now?: () => number;
  // Replaces the system CA store; for tests against a throwaway CA.
  ca?: string;
  // The auth header's value, from the secret store.
  secret?: string;
}

export function probe(spec: CheckSpec, options: ProbeOptions = {}): Promise<ProbeOutcome> {
  return spec.kind === "http" ? probeHttp(spec, options.now ?? Date.now, options) : probeTcp(spec);
}

function statusExpected(spec: CheckSpec, status: number): boolean {
  if (spec.expectStatus?.length) return spec.expectStatus.includes(status);
  return status >= 200 && status < 400;
}

function expectedText(spec: CheckSpec): string {
  return spec.expectStatus?.length ? spec.expectStatus.join(", ") : "2xx or 3xx";
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// value is the latency in ms, so health.rules thresholds ("checks/<id>":
// warnAbove/critAbove) give a check a latency limit.
export function judge(spec: CheckSpec, outcome: ProbeOutcome, observedAt: string): CheckResult {
  const base = {
    id: spec.id,
    label: spec.label,
    observedAt,
    ...(spec.kind === "http" ? { deepLink: spec.target } : {}),
  };
  const raw = { target: spec.target, ...outcome };

  if (outcome.error) {
    const code =
      outcome.error.code && !outcome.error.message.includes(outcome.error.code) ? ` (${outcome.error.code})` : "";
    const during = outcome.error.during === "body" ? `HTTP ${outcome.httpStatus ?? 0}, then reading the body: ` : "";
    return { ...base, status: "crit", detail: `${during}${outcome.error.message}${code}`, raw };
  }

  const latency = outcome.latencyMs ?? 0;
  const value = latency;
  if (spec.kind === "tcp") {
    return { ...base, status: "ok", value, detail: `Connected in ${latency} ms` };
  }

  const httpStatus = outcome.httpStatus ?? 0;
  if (!statusExpected(spec, httpStatus)) {
    return {
      ...base,
      status: "crit",
      value,
      detail: `HTTP ${httpStatus} in ${latency} ms; expected ${expectedText(spec)}`,
      raw,
    };
  }

  if (spec.bodyMatch && outcome.bodyMatched === false) {
    const where = outcome.bodyTruncated ? `the first ${MAX_BODY_BYTES} bytes of the body` : "body";
    return {
      ...base,
      status: "crit",
      value,
      detail: `HTTP ${httpStatus} in ${latency} ms; ${where} does not contain ${JSON.stringify(spec.bodyMatch)}`,
      raw,
    };
  }

  const parts = [`${httpStatus} in ${latency} ms`];
  if (spec.bodyMatch) parts.push("body matched");
  let status: CheckResult["status"] = "ok";
  const cert = outcome.certificate;
  if (cert) {
    if (cert.daysLeft < 0) {
      status = "crit";
      parts.push(`certificate expired ${cert.validTo.slice(0, 10)}`);
    } else {
      parts.push(`certificate valid ${plural(cert.daysLeft, "day")}`);
      if (spec.tlsWarnDays > 0 && cert.daysLeft < spec.tlsWarnDays / 3) status = "crit";
      else if (spec.tlsWarnDays > 0 && cert.daysLeft < spec.tlsWarnDays) status = "warn";
    }
  }
  if (spec.insecureSkipVerify && spec.target.startsWith("https:")) {
    parts.push("certificate not verified (insecureSkipVerify)");
  }
  const result: CheckResult = { ...base, status, value, detail: parts.join("; ") };
  return status === "ok" ? result : { ...result, raw };
}

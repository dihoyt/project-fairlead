import type { CheckRequest, CheckView } from "@contracts/checks";

// An empty expectStatus means any 2xx or 3xx; accepting one more code has to
// spell those out, or the check would fail once the target answers 200 again.
const USUAL_OK = [200, 204, 301, 302, 303, 307, 308];

// The HTTP status of the last run when that status is what made it fail or
// warn. A 5xx is the target failing, so it is never offered for acceptance.
export function unexpectedStatus(check: CheckView): number | undefined {
  const last = check.last;
  if (check.kind !== "http" || !last || (last.status !== "warn" && last.status !== "crit")) return undefined;
  const code = (last.raw as { httpStatus?: unknown } | undefined)?.httpStatus;
  if (typeof code !== "number" || code < 100 || code >= 500) return undefined;
  const expected = check.expectStatus?.length ? check.expectStatus.includes(code) : code >= 200 && code < 400;
  return expected ? undefined : code;
}

// The update that records `code` as expected, keeping everything else (the
// secret is omitted, which keeps the stored one).
export function acceptStatusRequest(check: CheckView, code: number): CheckRequest {
  const base = check.expectStatus?.length ? check.expectStatus : USUAL_OK;
  const req: CheckRequest = {
    label: check.label,
    kind: check.kind,
    target: check.target,
    intervalMs: check.intervalMs,
    timeoutMs: check.timeoutMs,
    expectStatus: [...new Set([...base, code])].toSorted((a, b) => a - b),
    insecureSkipVerify: check.insecureSkipVerify ?? false,
    tlsWarnDays: check.tlsWarnDays,
    enabled: check.enabled,
  };
  if (check.bodyMatch) req.bodyMatch = check.bodyMatch;
  if (check.authHeader) req.authHeader = check.authHeader;
  return req;
}

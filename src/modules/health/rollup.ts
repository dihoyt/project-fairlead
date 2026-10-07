import { STATUS_SEVERITY } from "../../contracts/health.js";
import type { Category, CheckResult, HealthTile, Status } from "../../contracts/health.js";
import type { CheckRule } from "./settings.js";

export function worst(statuses: Iterable<Status>, empty: Status = "absent"): Status {
  let best = STATUS_SEVERITY.length;
  for (const status of statuses) best = Math.min(best, STATUS_SEVERITY.indexOf(status));
  return STATUS_SEVERITY[best] ?? empty;
}

export function severity(status: Status): number {
  return STATUS_SEVERITY.indexOf(status);
}

const CAP_ORDER: Status[] = ["ok", "warn", "crit"];

// Thresholds replace the provider's own ok/warn/crit judgement on a numeric
// value; "unknown" and "absent" are facts about reachability, not values, so
// no rule turns them into something else except `disabled`.
export function applyRule(result: CheckResult, rule: CheckRule | undefined): CheckResult {
  if (!rule) return result;
  if (rule.disabled) return { ...result, status: "absent", detail: `${result.detail} (disabled in settings)` };
  if (result.status === "unknown" || result.status === "absent") return result;

  let status = result.status;
  const value = typeof result.value === "number" ? result.value : Number.NaN;
  const hasThreshold =
    rule.warnAbove !== undefined ||
    rule.critAbove !== undefined ||
    rule.warnBelow !== undefined ||
    rule.critBelow !== undefined;
  if (hasThreshold && Number.isFinite(value)) {
    status = "ok";
    if (
      (rule.warnAbove !== undefined && value > rule.warnAbove) ||
      (rule.warnBelow !== undefined && value < rule.warnBelow)
    )
      status = "warn";
    if (
      (rule.critAbove !== undefined && value > rule.critAbove) ||
      (rule.critBelow !== undefined && value < rule.critBelow)
    )
      status = "crit";
  }
  if (rule.maxStatus && CAP_ORDER.indexOf(status) > CAP_ORDER.indexOf(rule.maxStatus)) status = rule.maxStatus;
  return status === result.status ? result : { ...result, status };
}

export type ProviderResult = CheckResult & { providerId: string };

const emptyCounts = (): HealthTile["counts"] => ({ ok: 0, warn: 0, crit: 0, unknown: 0, absent: 0 });

export function buildTile(category: Category, results: ProviderResult[], providerCount: number): HealthTile {
  const counts = emptyCounts();
  for (const result of results) counts[result.status] += 1;
  if (providerCount === 0) {
    return { category, status: "absent", summary: "Nothing reporting yet", counts };
  }
  if (results.length === 0) {
    return { category, status: "unknown", summary: "No results yet", counts };
  }
  const status = worst(results.map((r) => r.status));
  const ranked = results
    .filter((r) => r.status === status)
    .toSorted((a, b) => a.providerId.localeCompare(b.providerId) || a.id.localeCompare(b.id));
  const first = ranked[0];
  const visible = results.length - counts.absent;

  if (status === "ok")
    return { category, status, summary: `All ${visible} ${visible === 1 ? "check" : "checks"} OK`, counts };
  if (status === "absent") return { category, status, summary: first?.detail ?? "Not installed", counts };
  const more = ranked.length > 1 ? ` (+${ranked.length - 1} more)` : "";
  return { category, status, summary: `${first?.label}: ${first?.detail}${more}`, counts, worst: first };
}

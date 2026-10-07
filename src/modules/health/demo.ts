import type { CheckResult, HealthProvider, Status } from "../../contracts/health.js";

const CYCLE: Status[] = ["ok", "ok", "warn", "crit", "warn", "ok", "unknown"];

// Steps one check through every status, one step per run, beside one that
// stays healthy and one that is "not installed".
export function createDemoProvider(intervalMs = 30_000): HealthProvider {
  let step = 0;
  return {
    id: "health.demo",
    category: "checks",
    label: "Demo",
    intervalMs,
    async collect(): Promise<CheckResult[]> {
      const observedAt = new Date().toISOString();
      const status = CYCLE[step % CYCLE.length] ?? "ok";
      step += 1;
      const failing = status !== "ok";
      return [
        {
          id: "cycling",
          label: "Cycling check",
          status,
          value: step,
          detail: failing ? `Step ${step}: demo check is ${status}` : `Step ${step}: demo check is fine`,
          ...(failing ? { raw: { step, status } } : {}),
          observedAt,
        },
        { id: "steady", label: "Steady check", status: "ok", detail: "Always fine", observedAt },
        { id: "missing", label: "Optional component", status: "absent", detail: "Not installed", observedAt },
      ];
    },
  };
}

import type { CheckResult, HealthProvider } from "../../contracts/health.js";
import type { K8sService } from "./api.js";
import { NotConfiguredError } from "./api.js";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// The connection itself and whether the reads the product depends on are
// granted. Permissions are a warning, not critical: a missing grant hides
// one feature, it doesn't break the cluster.
export function connectionHealthProvider(k8s: K8sService, now: () => Date = () => new Date()): HealthProvider {
  return {
    id: "k8s",
    category: "cluster",
    label: "Kubernetes API",
    intervalMs: 60_000,
    async collect(): Promise<CheckResult[]> {
      const observedAt = now().toISOString();
      const conn = k8s.connection();
      let version;
      try {
        version = await k8s.version();
      } catch (err) {
        const notConfigured = err instanceof NotConfiguredError;
        return [
          {
            id: "api",
            label: "API server",
            status: notConfigured ? "unknown" : "crit",
            detail: notConfigured ? message(err) : `Cannot reach ${conn.server}: ${message(err)}`,
            raw: { source: conn.source, server: conn.server, context: conn.context, error: message(err) },
            observedAt,
          },
        ];
      }
      const api: CheckResult = {
        id: "api",
        label: "API server",
        status: "ok",
        value: version.gitVersion,
        detail: `Connected to ${version.gitVersion} (${conn.source === "in-cluster" ? "in-cluster" : `kubeconfig context ${conn.context}`})`,
        observedAt,
      };
      let access: CheckResult;
      try {
        const report = await k8s.capabilities();
        // A group that isn't installed is not a permissions problem.
        const denied = report.capabilities.filter((c) => c.groupPresent && !c.allowed);
        const missing = denied.filter((c) => !c.optIn);
        const off = denied.filter((c) => c.optIn);
        const offNote = off.length ? `; off by chart default: ${off.map((c) => c.label).join(", ")}` : "";
        access = {
          id: "access",
          label: "Read access",
          status: missing.length ? "warn" : "ok",
          value: missing.length,
          detail: missing.length
            ? `Missing ${missing.length} read${missing.length === 1 ? "" : "s"}: ${missing.map((c) => c.needs).join(", ")}${offNote}`
            : `All ${report.capabilities.filter((c) => c.groupPresent).length - off.length} reads granted${offNote}`,
          ...(missing.length ? { raw: missing } : {}),
          observedAt,
        };
      } catch (err) {
        access = {
          id: "access",
          label: "Read access",
          status: "unknown",
          detail: `Access review failed: ${message(err)}`,
          raw: { error: message(err) },
          observedAt,
        };
      }
      return [api, access];
    },
  };
}

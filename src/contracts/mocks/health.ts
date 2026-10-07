import type { Category, CheckResult, HealthProvider, Status } from "../health.js";
import { isoAgo } from "./time.js";

// One result in every status.
export const mockCheckResults: Record<Status, CheckResult> = {
  ok: {
    id: "nodes.ready",
    label: "Nodes Ready",
    status: "ok",
    value: 3,
    detail: "3/3 nodes Ready",
    observedAt: isoAgo(30_000),
  },
  warn: {
    id: "certs.expiry",
    label: "Certificate expiry",
    status: "warn",
    value: 12,
    detail: "grafana-tls in monitoring expires in 12 days",
    deepLink: "https://rancher.example.test/dashboard/c/local/explorer/cert-manager.io.certificate",
    object: { kind: "Certificate", namespace: "monitoring", name: "grafana-tls" },
    observedAt: isoAgo(30_000),
  },
  crit: {
    id: "pods.crashloop",
    label: "Crashlooping pods",
    status: "crit",
    value: 1,
    detail: "media/jellyfin-7c9d8 restarting (CrashLoopBackOff, 14 restarts)",
    raw: { namespace: "media", pod: "jellyfin-7c9d8", reason: "CrashLoopBackOff", restartCount: 14 },
    object: { kind: "Pod", namespace: "media", name: "jellyfin-7c9d8" },
    observedAt: isoAgo(30_000),
  },
  unknown: {
    id: "kubelet.stats",
    label: "Kubelet stats",
    status: "unknown",
    detail: "Could not reach the kubelet on node-3: connect ETIMEDOUT",
    observedAt: isoAgo(30_000),
  },
  absent: {
    id: "velero.installed",
    label: "Velero",
    status: "absent",
    detail: "Velero CRDs are not installed in this cluster",
    observedAt: isoAgo(30_000),
  },
};

export const mockCheckResultList: CheckResult[] = Object.values(mockCheckResults);

// A provider whose results the test sets; `set` changes what the next
// collect() returns, which is how a test drives a check ok → warn → crit.
export interface MockHealthProvider extends HealthProvider {
  set(results: CheckResult[]): void;
  calls: number;
}

export function createMockHealthProvider(
  id: string,
  category: Category,
  results: CheckResult[] = [mockCheckResults.ok],
  intervalMs = 30_000
): MockHealthProvider {
  let current = results;
  const provider: MockHealthProvider = {
    id,
    category,
    label: id,
    intervalMs,
    calls: 0,
    async collect() {
      provider.calls += 1;
      return current.map((result) => ({ ...result }));
    },
    set(next) {
      current = next;
    },
  };
  return provider;
}

export function withStatus(result: CheckResult, status: Status, detail = result.detail): CheckResult {
  return { ...result, status, detail };
}

import type { CheckResult, HealthProvider } from "../../contracts/health.js";
import { clusterView, databaseViews, type Snapshot } from "./read.js";

export const HEALTH_INTERVAL_MS = 60_000;

// The shared cluster's state and its databases, on the storage tile.
// Nothing to report ("absent") while there is no shared cluster.
export function createHealthProvider(load: () => Promise<Snapshot>, now: () => Date): HealthProvider {
  return {
    id: "postgres",
    category: "storage",
    label: "Shared Postgres",
    intervalMs: HEALTH_INTERVAL_MS,
    async collect(): Promise<CheckResult[]> {
      const observedAt = now().toISOString();
      let snapshot: Snapshot;
      try {
        snapshot = await load();
      } catch (err) {
        const detail = `Could not read the Postgres clusters: ${err instanceof Error ? err.message : String(err)}`;
        return [{ id: "cluster", label: "Shared Postgres", status: "unknown", detail, observedAt }];
      }
      const view = clusterView(snapshot, observedAt);
      if (view.state === "absent" || !view.name) {
        return [
          {
            id: "cluster",
            label: "Shared Postgres",
            status: "absent",
            detail: snapshot.absent ? "CloudNativePG is not installed" : "No shared Postgres cluster",
            observedAt,
          },
        ];
      }
      const object = { kind: "Cluster", namespace: view.namespace, name: view.name };
      const counts = `${view.readyInstances}/${view.instances} instances ready`;
      const cluster: CheckResult =
        view.state === "ready"
          ? { id: "cluster", label: "Shared Postgres", status: "ok", detail: counts, object, observedAt }
          : {
              id: "cluster",
              label: "Shared Postgres",
              status: view.state === "starting" ? "warn" : view.readyInstances === 0 ? "crit" : "warn",
              detail: `${counts}${view.phase ? `: ${view.phase}` : ""}${view.message ? ` (${view.message})` : ""}`,
              raw: snapshot.current?.status,
              object,
              observedAt,
            };
      const pending = databaseViews(snapshot).filter((db) => !db.applied);
      const databases: CheckResult =
        pending.length === 0
          ? {
              id: "databases",
              label: "Postgres databases",
              status: "ok",
              detail: "Every database is in place",
              observedAt,
            }
          : {
              id: "databases",
              label: "Postgres databases",
              status: "warn",
              detail: `Not in place yet: ${pending.map((db) => `${db.database}${db.message ? ` (${db.message})` : ""}`).join(", ")}`,
              raw: pending,
              observedAt,
            };
      return [cluster, databases];
    },
  };
}

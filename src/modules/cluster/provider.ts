import type { CheckResult, HealthProvider } from "../../contracts/health.js";
import { RESOURCES, type K8sApi, type KubeObject, type ResourceRef, type Watch } from "../../contracts/k8s.js";
import { judge, type Snapshot, type VolumeStat } from "./judge.js";
import type { Linker } from "./links.js";
import { RestartTracker } from "./restarts.js";
import type { Thresholds } from "./settings.js";

const asError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// An unserved group is asked about again after this long, so installing
// cert-manager shows up without a restart.
const ABSENT_RETRY_MS = 5 * 60_000;

interface ProviderDeps {
  k8s: () => K8sApi;
  thresholds: () => Thresholds;
  link: Linker;
  now?: () => number;
}

interface Cached {
  watch: Watch<KubeObject> | "absent";
  at: number;
}

// One informer per resource, started on first collect and reused: a
// collect reads the caches rather than listing the cluster every minute.
function createWatchCache(k8s: () => K8sApi, now: () => number) {
  const cache = new Map<string, Promise<Cached>>();
  return async (ref: ResourceRef): Promise<KubeObject[] | "absent"> => {
    const key = `${ref.group}/${ref.plural}`;
    let entry = cache.get(key);
    if (entry) {
      const settled = await entry.catch(() => undefined);
      if (!settled || (settled.watch === "absent" && now() - settled.at >= ABSENT_RETRY_MS)) entry = undefined;
    }
    if (!entry) {
      entry = (async () => {
        const watch = await k8s().watch(ref);
        if (watch !== "absent") await watch.synced;
        return { watch, at: now() };
      })();
      cache.set(key, entry);
    }
    const { watch } = await entry;
    return watch === "absent" ? "absent" : watch.list();
  };
}

const core = (list: KubeObject[] | "absent") => (list === "absent" ? [] : list);

interface SummaryVolume {
  usedBytes?: number;
  capacityBytes?: number;
  pvcRef?: { name: string; namespace: string };
}

async function volumeStats(k8s: K8sApi, nodes: KubeObject[]): Promise<Snapshot["volumes"]> {
  const stats: VolumeStat[] = [];
  const errors: string[] = [];
  // A NotReady node's kubelet would only time out.
  const ready = nodes.filter((n) =>
    (n.status as { conditions?: Array<{ type: string; status: string }> } | undefined)?.conditions?.some(
      (c) => c.type === "Ready" && c.status === "True"
    )
  );
  await Promise.all(
    ready.map(async (node) => {
      const name = node.metadata.name;
      try {
        const summary = (await k8s.raw(`/api/v1/nodes/${encodeURIComponent(name)}/proxy/stats/summary`)) as {
          pods?: Array<{ volume?: SummaryVolume[] }>;
        };
        for (const pod of summary.pods ?? []) {
          for (const v of pod.volume ?? []) {
            if (!v.pvcRef || !v.capacityBytes) continue;
            stats.push({
              namespace: v.pvcRef.namespace,
              name: v.pvcRef.name,
              node: name,
              usedBytes: v.usedBytes ?? 0,
              capacityBytes: v.capacityBytes,
            });
          }
        }
      } catch (err) {
        errors.push(`${name}: ${message(err)}`);
      }
    })
  );
  return { stats, errors };
}

export function clusterHealthProvider(deps: ProviderDeps): HealthProvider {
  const now = deps.now ?? Date.now;
  const restarts = new RestartTracker();
  let read: ReturnType<typeof createWatchCache> | undefined;

  return {
    id: "cluster",
    category: "cluster",
    label: "Cluster",
    intervalMs: 60_000,
    async collect(): Promise<CheckResult[]> {
      const at = now();
      const observedAt = new Date(at).toISOString();
      let snapshot: Snapshot;
      try {
        const k8s = deps.k8s();
        read ??= createWatchCache(deps.k8s, now);
        const [nodes, pods, pvcs, certificates, version, serverInfo] = await Promise.all([
          read(RESOURCES.nodes),
          read(RESOURCES.pods),
          read(RESOURCES.pvcs),
          read(RESOURCES.certificates),
          k8s.version().catch(asError),
          k8s.serverInfo?.().catch(asError),
        ]);
        snapshot = {
          nodes: core(nodes),
          pods: core(pods),
          pvcs: core(pvcs),
          certificates,
          version,
          ...(serverInfo ? { serverInfo } : {}),
          volumes: await volumeStats(k8s, core(nodes)),
        };
      } catch (err) {
        return [
          {
            id: "snapshot",
            label: "Cluster state",
            status: "unknown",
            detail: `Cannot read cluster state: ${message(err)}`,
            raw: { error: message(err) },
            observedAt,
          },
        ];
      }
      const thresholds = deps.thresholds();
      restarts.observe(snapshot.pods, at, thresholds.restartSpikeMinutes * 60_000);
      return judge(snapshot, {
        now: at,
        thresholds,
        link: deps.link,
        restartsInWindow: (pod, container) => restarts.inWindow(pod, container),
      });
    },
  };
}

import type { MetricsCollector, Sample } from "../../contracts/metrics.js";
import { pvcOf, type Load, type Snapshot } from "./model.js";

export const SIZE_SERIES = "longhorn.volume.size.bytes";
// Space the volume takes on disk per replica, snapshots included, so it can
// exceed the provisioned size.
export const ACTUAL_SERIES = "longhorn.volume.actual.bytes";

export function volumeSamples(snapshot: Snapshot): Sample[] {
  const samples: Sample[] = [];
  for (const volume of snapshot.volumes) {
    const pvc = pvcOf(volume);
    const labels: Record<string, string> = {
      volume: volume.metadata.name,
      ...(pvc ? { namespace: pvc.namespace, pvc: pvc.name } : {}),
    };
    const size = Number(volume.spec?.size);
    const actual = Number(volume.status?.actualSize);
    if (volume.spec?.size && Number.isFinite(size)) {
      samples.push({ series: SIZE_SERIES, labels, ts: snapshot.takenAt, value: size });
    }
    if (volume.status?.actualSize && Number.isFinite(actual)) {
      samples.push({ series: ACTUAL_SERIES, labels, ts: snapshot.takenAt, value: actual });
    }
  }
  return samples;
}

export function createCollector(load: Load): MetricsCollector {
  return {
    id: "longhorn",
    intervalMs: 60_000,
    async collect() {
      try {
        const snapshot = await load();
        return snapshot === "absent" ? [] : volumeSamples(snapshot);
      } catch {
        // The storage health provider reports the same failure.
        return [];
      }
    },
  };
}

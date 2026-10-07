import type { KubeObject } from "../../contracts/k8s.js";

interface Sample {
  at: number;
  count: number;
}

interface ContainerStatus {
  name: string;
  restartCount?: number;
}

// Restart counts only ever grow for a given pod, so the restarts within a
// window are the latest count minus the last one seen at or before the
// window's start. Kept in memory: after a restart of this process the first
// window has no baseline and reports nothing, which errs quiet.
export class RestartTracker {
  private samples = new Map<string, Sample[]>();

  private key(pod: KubeObject, container: string) {
    // The uid tells a recreated pod of the same name apart.
    return `${pod.metadata.namespace}/${pod.metadata.name}/${pod.metadata.uid ?? ""}/${container}`;
  }

  observe(pods: KubeObject[], now: number, windowMs: number): void {
    const seen = new Set<string>();
    for (const pod of pods) {
      const statuses = (pod.status as { containerStatuses?: ContainerStatus[] } | undefined)?.containerStatuses ?? [];
      for (const c of statuses) {
        const key = this.key(pod, c.name);
        seen.add(key);
        const list = this.samples.get(key) ?? [];
        list.push({ at: now, count: c.restartCount ?? 0 });
        // Keep one sample at or before the window's start as the baseline.
        while (list.length > 1 && list[1]!.at <= now - windowMs) list.shift();
        this.samples.set(key, list);
      }
    }
    for (const key of this.samples.keys()) if (!seen.has(key)) this.samples.delete(key);
  }

  // Undefined until there is a baseline from an earlier observation.
  inWindow(pod: KubeObject, container: string): number | undefined {
    const list = this.samples.get(this.key(pod, container));
    if (!list || list.length < 2) return undefined;
    return Math.max(0, list.at(-1)!.count - list[0]!.count);
  }
}

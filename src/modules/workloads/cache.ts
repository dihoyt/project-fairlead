import type { K8sApi, KubeObject, ResourceRef, Watch } from "../../contracts/k8s.js";
import { HttpError } from "../../runtime/http.js";
import { errorMessage } from "../../runtime/log.js";

export interface CacheOptions {
  k8s: () => K8sApi;
  // A failed start is remembered this long, so a forbidden resource is not
  // re-listed on every page refresh.
  retryMs?: number;
  // Watches nobody has read for this long are stopped by sweep().
  idleMs?: number;
  now?: () => number;
}

interface Entry {
  watch?: Watch<KubeObject> | "absent";
  starting?: Promise<Watch<KubeObject> | "absent">;
  failed?: { at: number; message: string; status: number };
  usedAt: number;
}

// Cluster-wide watches, started on first read and served from the
// informer's cache after that, so browsing never lists the cluster per click.
export class ObjectCache {
  private readonly entries = new Map<ResourceRef, Entry>();
  private readonly options: Required<CacheOptions>;

  constructor(options: CacheOptions) {
    this.options = { retryMs: 30_000, idleMs: 15 * 60_000, now: Date.now, ...options };
  }

  async list<T extends KubeObject>(ref: ResourceRef): Promise<T[]> {
    const now = this.options.now();
    let entry = this.entries.get(ref);
    if (!entry) {
      entry = { usedAt: now };
      this.entries.set(ref, entry);
    }
    entry.usedAt = now;
    if (entry.failed && now - entry.failed.at < this.options.retryMs) {
      throw new HttpError(entry.failed.status, entry.failed.message);
    }
    if (!entry.watch) {
      entry.starting ??= this.start(ref, entry);
      await entry.starting;
    }
    const watch = entry.watch;
    return !watch || watch === "absent" ? [] : (watch.list() as T[]);
  }

  private async start(ref: ResourceRef, entry: Entry): Promise<Watch<KubeObject> | "absent"> {
    try {
      const watch = await this.options.k8s().watch(ref);
      if (watch !== "absent") await watch.synced;
      entry.watch = watch;
      entry.failed = undefined;
      return watch;
    } catch (err) {
      const code = (err as { statusCode?: unknown }).statusCode;
      const status = code === 403 ? 403 : 503;
      const message =
        status === 403
          ? `Not allowed to watch ${ref.plural}: the service account needs list and watch on it.`
          : `Could not read ${ref.plural} from the cluster: ${errorMessage(err)}`;
      entry.failed = { at: this.options.now(), message, status };
      throw new HttpError(status, message);
    } finally {
      entry.starting = undefined;
    }
  }

  sweep(): void {
    const now = this.options.now();
    for (const [ref, entry] of this.entries) {
      if (entry.starting || now - entry.usedAt < this.options.idleMs) continue;
      if (entry.watch && entry.watch !== "absent") entry.watch.stop();
      this.entries.delete(ref);
    }
  }

  stopAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.watch && entry.watch !== "absent") entry.watch.stop();
    }
    this.entries.clear();
  }
}

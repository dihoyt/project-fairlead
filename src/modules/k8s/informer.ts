import type { KubeConfig } from "@kubernetes/client-node";
import type { KubeObject, ListOptions, ResourceRef, Watch, WatchHandlers } from "../../contracts/k8s.js";
import { collectionPath, objectKey, withTypeMeta } from "./paths.js";
import { K8sError, openRequest, readLines, requestJson } from "./transport.js";

interface ListBody {
  metadata?: { resourceVersion?: string };
  items?: KubeObject[];
}

interface WatchEvent {
  type: "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK" | "ERROR";
  object: KubeObject & { code?: number; message?: string; reason?: string };
}

export interface InformerTiming {
  // Server-side watch timeout; the API server ends the stream and we
  // resume from the last resourceVersion. Randomised per watch, as
  // client-go does, so many watches don't reconnect in lockstep.
  watchSeconds?: [min: number, max: number];
  backoffMs?: [base: number, max: number];
}

// A list plus option-compatible query for both the list and the watch.
export function listQuery(options: ListOptions) {
  return { labelSelector: options.labelSelector, fieldSelector: options.fieldSelector };
}

export async function listObjects<T extends KubeObject>(
  kc: KubeConfig,
  ref: ResourceRef,
  options: ListOptions = {}
): Promise<{ items: T[]; resourceVersion: string }> {
  const body = await requestJson<ListBody>(kc, collectionPath(ref, options.namespace), {
    query: listQuery(options),
  });
  return {
    items: (body.items ?? []).map((item) => withTypeMeta(ref, item as T)),
    resourceVersion: body.metadata?.resourceVersion ?? "",
  };
}

class Gone extends Error {}

// One list+watch over one (resource, namespace, selectors), shared by every
// watch() asking for the same thing. Keeps a cache keyed namespace/name,
// resumes from the last resourceVersion when a stream ends, relists on 410
// Gone (diffing the new list against the cache so handlers see the adds,
// updates and deletes they missed), and retries any other failure with
// capped backoff, reporting it to each subscriber's error handler.
export class Informer<T extends KubeObject = KubeObject> {
  readonly ref: ResourceRef;
  readonly options: ListOptions;
  private readonly kc: () => KubeConfig;
  private readonly timing: Required<InformerTiming>;
  private readonly cache = new Map<string, T>();
  private readonly subscribers = new Set<WatchHandlers<T>>();
  private resourceVersion = "";
  private stopped = false;
  private abort: AbortController | undefined;
  private wake: (() => void) | undefined;
  private loop: Promise<void> | undefined;
  // How many times the cache was rebuilt from a full list (1 after start).
  lists = 0;

  constructor(kc: () => KubeConfig, ref: ResourceRef, options: ListOptions, timing: InformerTiming = {}) {
    this.kc = kc;
    this.ref = ref;
    this.options = options;
    this.timing = { watchSeconds: timing.watchSeconds ?? [300, 600], backoffMs: timing.backoffMs ?? [1000, 30_000] };
  }

  // The initial list. Throws (forbidden, unreachable) without starting the
  // watch loop, so the caller decides what a failure means.
  async start(): Promise<void> {
    await this.relist();
    this.loop = this.run();
  }

  list(): T[] {
    return [...this.cache.values()];
  }

  // Replays the cache as adds, then delivers live changes.
  subscribe(handlers: WatchHandlers<T>): () => void {
    this.subscribers.add(handlers);
    for (const obj of this.cache.values()) this.deliver(handlers, "add", obj);
    return () => void this.subscribers.delete(handlers);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    this.wake?.();
    await this.loop;
  }

  private deliver(handlers: WatchHandlers<T>, verb: "add" | "update" | "delete" | "error", obj: unknown, old?: T) {
    try {
      if (verb === "add") handlers.add?.(obj as T);
      else if (verb === "update") handlers.update?.(obj as T, old!);
      else if (verb === "delete") handlers.delete?.(obj as T);
      else handlers.error?.(obj as Error);
    } catch {
      // A throwing handler must not stop the informer or other subscribers.
    }
  }

  private emit(verb: "add" | "update" | "delete" | "error", obj: unknown, old?: T) {
    for (const handlers of this.subscribers) this.deliver(handlers, verb, obj, old);
  }

  private async relist(): Promise<void> {
    const { items, resourceVersion } = await listObjects<T>(this.kc(), this.ref, this.options);
    const fresh = new Map(items.map((item) => [objectKey(item), item]));
    for (const [key, old] of this.cache) {
      if (!fresh.has(key)) {
        this.cache.delete(key);
        this.emit("delete", old);
      }
    }
    for (const [key, obj] of fresh) this.apply(key, obj);
    this.resourceVersion = resourceVersion;
    this.lists++;
  }

  private apply(key: string, obj: T) {
    const old = this.cache.get(key);
    this.cache.set(key, obj);
    if (!old) this.emit("add", obj);
    else if (old.metadata.resourceVersion !== obj.metadata.resourceVersion) this.emit("update", obj, old);
  }

  private async watchOnce(): Promise<void> {
    const [min, max] = this.timing.watchSeconds;
    const timeoutSeconds = Math.round(min + Math.random() * (max - min));
    this.abort = new AbortController();
    const res = await openRequest(this.kc(), collectionPath(this.ref, this.options.namespace), {
      query: {
        ...listQuery(this.options),
        watch: 1,
        resourceVersion: this.resourceVersion,
        allowWatchBookmarks: true,
        timeoutSeconds,
      },
      signal: this.abort.signal,
      // A half-open connection otherwise waits forever for the next event.
      idleTimeoutMs: (timeoutSeconds + 30) * 1000,
    });
    let failure: Error | undefined;
    await readLines(res, (line) => {
      if (!line.trim() || failure) return;
      let event: WatchEvent;
      try {
        event = JSON.parse(line) as WatchEvent;
      } catch {
        return;
      }
      if (event.type === "ERROR") {
        const code = event.object.code;
        failure =
          code === 410
            ? new Gone(event.object.message ?? "resourceVersion too old")
            : new K8sError(code ?? 500, event.object.message ?? "watch error", event.object.reason);
        res.destroy();
        return;
      }
      const rv = event.object.metadata?.resourceVersion;
      if (rv) this.resourceVersion = rv;
      if (event.type === "BOOKMARK") return;
      const obj = withTypeMeta(this.ref, event.object as unknown as T);
      const key = objectKey(obj);
      if (event.type === "DELETED") {
        const old = this.cache.get(key);
        this.cache.delete(key);
        this.emit("delete", old ?? obj);
      } else {
        this.apply(key, obj);
      }
    });
    if (failure) throw failure;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private async run(): Promise<void> {
    const [base, max] = this.timing.backoffMs;
    let delay = 0;
    while (!this.stopped) {
      try {
        if (!this.resourceVersion) await this.relist();
        await this.watchOnce();
        delay = 0;
      } catch (err) {
        if (this.stopped) break;
        if (err instanceof Gone || (err instanceof K8sError && err.statusCode === 410)) {
          this.resourceVersion = "";
          continue;
        }
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
        delay = Math.min(delay ? delay * 2 : base, max);
        await this.sleep(delay);
      }
    }
  }
}

const informerKey = (ref: ResourceRef, options: ListOptions) =>
  JSON.stringify([
    ref.group,
    ref.version,
    ref.plural,
    ref.namespaced ? (options.namespace ?? "") : "",
    options.labelSelector ?? "",
    options.fieldSelector ?? "",
  ]);

// Shares informers between watch() calls and stops one when its last
// watcher stops.
export class InformerPool {
  private readonly informers = new Map<string, Promise<Informer>>();
  private readonly kc: () => KubeConfig;
  private readonly timing: InformerTiming;

  constructor(kc: () => KubeConfig, timing: InformerTiming = {}) {
    this.kc = kc;
    this.timing = timing;
  }

  async watch<T extends KubeObject>(
    ref: ResourceRef,
    options: ListOptions,
    handlers: WatchHandlers<T>
  ): Promise<Watch<T>> {
    const key = informerKey(ref, options);
    let pending = this.informers.get(key);
    if (!pending) {
      const informer = new Informer(this.kc, ref, options, this.timing);
      pending = informer.start().then(() => informer);
      this.informers.set(key, pending);
      pending.catch(() => this.informers.delete(key));
    }
    const informer = (await pending) as unknown as Informer<T>;
    const unsubscribe = informer.subscribe(handlers);
    let stopped = false;
    return {
      synced: Promise.resolve(),
      list: () => informer.list(),
      stop: () => {
        if (stopped) return;
        stopped = true;
        unsubscribe();
        if (informer.subscriberCount === 0 && this.informers.get(key) === pending) {
          this.informers.delete(key);
          void informer.stop();
        }
      },
    };
  }

  get size(): number {
    return this.informers.size;
  }

  async stopAll(): Promise<void> {
    const all = [...this.informers.values()];
    this.informers.clear();
    await Promise.all(all.map((p) => p.then((i) => i.stop()).catch(() => undefined)));
  }
}

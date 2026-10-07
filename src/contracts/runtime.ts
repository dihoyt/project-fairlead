import type { Database } from "better-sqlite3";
import type { K8sApi } from "./k8s.js";
import type { JobStatus } from "./system.js";

export type { JobStatus };

export interface Migration {
  // 1, 2, 3 … per module, contiguous. Never renumber or edit an applied one.
  version: number;
  name: string;
  // Additive only: during a rollout the old pod runs against the new schema.
  // Every table a module owns carries org_id (see CLAUDE.md).
  up: string | ((db: Database) => void);
}

export interface JobOptions {
  // Random delay added to each start, so jobs with the same interval spread
  // out. Default: 10% of the interval, capped at 30s.
  jitterMs?: number;
  // The run's AbortSignal fires and the run counts as failed after this.
  // Default: the interval, capped at 60s.
  timeoutMs?: number;
  // Default true: first run shortly after start rather than after one interval.
  runImmediately?: boolean;
}

export interface JobHandle {
  name: string;
  stop(): void;
  // Runs now unless a run is already in flight, in which case it waits for that one.
  runNow(): Promise<void>;
}

export interface Scheduler {
  // fn never brings the process down: throws, rejections and timeouts are
  // recorded on the job's status. A run still in flight when the next is due
  // is not overlapped; that tick is skipped.
  every(name: string, intervalMs: number, fn: (signal: AbortSignal) => unknown, options?: JobOptions): JobHandle;
  list(): JobStatus[];
}

// Cross-module services, provided by the module that owns them and looked
// up by the ones that use them, so nobody imports another module's files.
export interface Services {
  // Provided by module "k8s" (A1).
  k8s: K8sApi;
}

export interface ServiceRegistry {
  provide<K extends keyof Services>(name: K, impl: Services[K]): void;
  // Throws if nothing has provided it yet. Call it when the service is
  // needed (inside collect()), not at register time.
  get<K extends keyof Services>(name: K): Services[K];
  has(name: keyof Services): boolean;
}

export interface Logger {
  info(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
  error(message: string, detail?: Record<string, unknown>): void;
}

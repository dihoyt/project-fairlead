import type { JobHandle, JobOptions, JobStatus, Logger, Scheduler } from "../contracts/runtime.js";
import { errorMessage } from "./log.js";

const MAX_DEFAULT_JITTER_MS = 30_000;
const MAX_DEFAULT_TIMEOUT_MS = 60_000;

export interface SchedulerCore {
  forModule(module: string): Scheduler;
  list(): JobStatus[];
  // Stops every job and waits for runs in flight, which have been aborted.
  stopAll(): Promise<void>;
}

interface Job {
  status: JobStatus;
  handle: JobHandle;
  stop(): void;
  inFlight: Promise<void> | null;
}

export function createScheduler(log: Logger, random: () => number = Math.random): SchedulerCore {
  const jobs = new Map<string, Job>();

  function every(
    module: string,
    name: string,
    intervalMs: number,
    fn: (signal: AbortSignal) => unknown,
    options: JobOptions = {}
  ): JobHandle {
    if (!(intervalMs > 0)) throw new Error(`Job "${name}" needs a positive interval, got ${intervalMs}.`);
    const key = `${module}/${name}`;
    if (jobs.has(key)) throw new Error(`Job "${key}" is already scheduled.`);

    const jitterMs = options.jitterMs ?? Math.min(intervalMs * 0.1, MAX_DEFAULT_JITTER_MS);
    const timeoutMs = options.timeoutMs ?? Math.min(intervalMs, MAX_DEFAULT_TIMEOUT_MS);
    const status: JobStatus = { name, module, intervalMs, running: false, runs: 0, failures: 0 };
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    let controller: AbortController | null = null;

    const schedule = (delay: number) => {
      if (stopped) return;
      status.nextRunAt = new Date(Date.now() + delay).toISOString();
      timer = setTimeout(tick, delay);
      // An idle job never keeps the process alive on its own; the HTTP server
      // does. A run in flight does, through its timeout timer.
      timer.unref();
    };
    const nextDelay = () => intervalMs + random() * jitterMs;

    const run = (): Promise<void> => {
      if (job.inFlight) return job.inFlight;
      controller = new AbortController();
      const signal = controller.signal;
      status.running = true;
      status.runs += 1;
      status.lastStartedAt = new Date().toISOString();
      let timeout: NodeJS.Timeout | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller?.abort(new Error(`timed out after ${timeoutMs}ms`));
          reject(new Error(`Timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });
      job.inFlight = Promise.race([Promise.resolve().then(() => fn(signal)), timedOut])
        .then(
          () => {
            status.lastOk = true;
            delete status.lastError;
          },
          (err: unknown) => {
            status.lastOk = false;
            status.failures += 1;
            status.lastError = errorMessage(err);
            log.warn("Scheduled job failed", { job: key, error: status.lastError });
          }
        )
        .finally(() => {
          clearTimeout(timeout);
          status.running = false;
          status.lastFinishedAt = new Date().toISOString();
          controller = null;
          job.inFlight = null;
        });
      return job.inFlight;
    };

    const tick = () => {
      status.heartbeatAt = new Date().toISOString();
      // An overrunning run is not overlapped; this tick is skipped.
      if (!job.inFlight) void run();
      schedule(nextDelay());
    };

    const job: Job = {
      status,
      inFlight: null,
      stop() {
        stopped = true;
        clearTimeout(timer);
        delete status.nextRunAt;
        controller?.abort(new Error("stopped"));
      },
      handle: {
        name,
        stop: () => {
          job.stop();
          jobs.delete(key);
        },
        runNow: () => run(),
      },
    };
    jobs.set(key, job);
    schedule(options.runImmediately === false ? nextDelay() : random() * Math.min(jitterMs, 1000));
    return job.handle;
  }

  return {
    forModule(module) {
      return {
        every: (name, intervalMs, fn, options) => every(module, name, intervalMs, fn, options),
        list: () => [...jobs.values()].filter((job) => job.status.module === module).map((job) => ({ ...job.status })),
      };
    },
    list: () => [...jobs.values()].map((job) => ({ ...job.status })),
    async stopAll() {
      const pending = [...jobs.values()].map((job) => {
        job.stop();
        return job.inFlight;
      });
      jobs.clear();
      await Promise.all(pending);
    },
  };
}

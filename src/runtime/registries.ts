import type { BackupSource, BackupsRegistry, CapacitySource } from "../contracts/backups.js";
import type { HealthProvider, HealthRegistry } from "../contracts/health.js";
import type { MetricsCollector, MetricsRegistry, Sample } from "../contracts/metrics.js";
import type { Logger } from "../contracts/runtime.js";
import { errorMessage } from "./log.js";

// Samples written before the metrics module installs its sink are kept up
// to this many, oldest dropped first.
export const PENDING_SAMPLE_LIMIT = 50_000;

// A list that tells subscribers about every entry, past and future, so the
// consuming module can register before or after its providers.
function replayList<T extends { id: string }>(kind: string, log: Logger) {
  const items: T[] = [];
  const listeners = new Set<(item: T) => void>();
  const notify = (listener: (item: T) => void, item: T) => {
    try {
      listener(item);
    } catch (err) {
      log.error(`${kind} subscriber failed`, { id: item.id, error: errorMessage(err) });
    }
  };
  return {
    add(item: T) {
      if (items.some((existing) => existing.id === item.id)) {
        throw new Error(`A ${kind} with id "${item.id}" is already registered.`);
      }
      items.push(item);
      for (const listener of listeners) notify(listener, item);
    },
    list: (): readonly T[] => [...items],
    subscribe(listener: (item: T) => void) {
      listeners.add(listener);
      for (const item of items) notify(listener, item);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function createHealthRegistry(log: Logger): HealthRegistry {
  const providers = replayList<HealthProvider>("health provider", log);
  return { addProvider: providers.add, list: providers.list, subscribe: providers.subscribe };
}

export function createMetricsRegistry(log: Logger): MetricsRegistry {
  const collectors = replayList<MetricsCollector>("metrics collector", log);
  let sink: ((samples: Sample[]) => void) | null = null;
  let pending: Sample[] = [];
  const deliver = (samples: Sample[]) => {
    try {
      sink?.(samples);
    } catch (err) {
      log.error("Metrics sink failed", { error: errorMessage(err) });
    }
  };
  return {
    addCollector: collectors.add,
    list: collectors.list,
    subscribe: collectors.subscribe,
    write(samples) {
      if (samples.length === 0) return;
      if (sink) {
        deliver(samples);
        return;
      }
      pending.push(...samples);
      if (pending.length > PENDING_SAMPLE_LIMIT) pending = pending.slice(pending.length - PENDING_SAMPLE_LIMIT);
    },
    setSink(next) {
      if (sink) throw new Error("A metrics sink is already installed.");
      sink = next;
      const held = pending;
      pending = [];
      if (held.length > 0) deliver(held);
    },
  };
}

export function createBackupsRegistry(log: Logger): BackupsRegistry {
  const sources = replayList<BackupSource>("backup source", log);
  const capacities = replayList<CapacitySource>("capacity source", log);
  return {
    addSource: sources.add,
    addCapacity: capacities.add,
    sources: sources.list,
    capacities: capacities.list,
    subscribe(listener) {
      const offSource = listener.onSource ? sources.subscribe((s) => listener.onSource!(s)) : () => {};
      const offCapacity = listener.onCapacity ? capacities.subscribe((c) => listener.onCapacity!(c)) : () => {};
      return () => {
        offSource();
        offCapacity();
      };
    },
  };
}

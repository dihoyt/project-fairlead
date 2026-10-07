import type { Status } from "./health.js";

// Every event on the bus, by name. Adding one is a contract change.
export type Events = {
  "health.changed": { providerId: string; checkId: string; label: string; from: Status; to: Status; detail: string };
};

export type EventName = keyof Events;

export interface EventBus<E extends Record<string, unknown> = Events> {
  // Handlers run after emit() returns, one at a time per event, and a
  // handler that throws or rejects is logged and does not affect others.
  on<K extends keyof E>(event: K, handler: (payload: E[K]) => void | Promise<void>): () => void;
  emit<K extends keyof E>(event: K, payload: E[K]): void;
}

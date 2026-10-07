import type { EventBus, Events } from "../contracts/events.js";
import type { Logger } from "../contracts/runtime.js";
import { errorMessage } from "./log.js";

export function createEventBus<E extends Record<string, unknown> = Events>(log: Logger): EventBus<E> {
  const handlers = new Map<keyof E, Set<(payload: never) => void | Promise<void>>>();
  return {
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) handlers.set(event, (set = new Set()));
      const entry = handler as (payload: never) => void | Promise<void>;
      set.add(entry);
      return () => {
        set.delete(entry);
      };
    },
    emit(event, payload) {
      const set = handlers.get(event);
      if (!set || set.size === 0) return;
      // A snapshot, so a handler unsubscribing mid-delivery doesn't skip the next one.
      const targets = [...set];
      // Deferred, so an emitter is never re-entered by its own subscribers
      // and never waits on them.
      queueMicrotask(async () => {
        for (const handler of targets) {
          try {
            await (handler as (payload: E[typeof event]) => void | Promise<void>)(payload);
          } catch (err) {
            log.error("Event handler failed", { event: String(event), error: errorMessage(err) });
          }
        }
      });
    },
  };
}

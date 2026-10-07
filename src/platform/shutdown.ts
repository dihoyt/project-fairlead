import type { Server } from "node:http";
import type { RequestHandler, Response } from "express";
import type { Logger } from "../contracts/runtime.js";

// Graceful hand-over during a rolling update. Kubernetes starts the new pod
// and waits for it to be ready, then sends this one SIGTERM after the preStop
// pause has taken it out of the Service. From then on this pod reports not
// ready (/healthz) and refuses new changes, live event streams are ended so
// their clients reconnect to the new pod, and it exits once in-flight
// requests are done or the deadline passes.

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_DRAIN_MS = 600_000;

export const DRAINING_MESSAGE = "This install is updating. Try again in a moment.";

export function drainDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.DRAIN_MS);
  return env.DRAIN_MS !== undefined && env.DRAIN_MS.trim() !== "" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_DRAIN_MS;
}

export interface Drain {
  guard: RequestHandler;
  draining(): boolean;
  inFlight(): number;
  // Resolves when it is safe to exit.
  drain(server: Server, maxMs: number): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createDrain(log: Logger): Drain {
  let draining = false;
  const open = new Set<Response>();

  // An event stream never finishes on its own, so waiting for it would hold
  // every drain to its deadline. Ending it is the reconnect signal.
  const endStreams = () => {
    for (const res of open) {
      if (String(res.getHeader("content-type") ?? "").startsWith("text/event-stream")) res.end();
    }
  };

  return {
    // Refuses new changes once draining, and counts every request (pages too)
    // so the drain can wait for them. Reads keep working until the very end:
    // the old pod is already out of the Service, so only a request that was
    // on its way when the drain began can reach it.
    guard(req, res, next) {
      if (draining && MUTATING.has(req.method)) {
        res.status(503).set("Retry-After", "5").json({ error: DRAINING_MESSAGE });
        return;
      }
      open.add(res);
      const finish = () => open.delete(res);
      res.on("finish", finish);
      res.on("close", finish);
      next();
    },
    draining: () => draining,
    inFlight: () => open.size,
    async drain(server, maxMs) {
      if (draining) return;
      draining = true;
      log.info("Draining: ending event streams and waiting for in-flight requests");
      const deadline = Date.now() + maxMs;
      let last = -1;
      while (Date.now() < deadline) {
        endStreams();
        if (open.size === 0) break;
        if (open.size !== last) log.info("Draining: waiting", { requests: open.size });
        last = open.size;
        await sleep(250);
      }
      if (open.size > 0) log.warn("Draining: deadline reached, stopping anyway", { requests: open.size });
      // Idle keep-alive sockets go now; one that just took a request gets a
      // moment to answer it.
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeIdleConnections();
      await Promise.race([closed, sleep(3000)]);
      server.closeAllConnections();
    },
  };
}

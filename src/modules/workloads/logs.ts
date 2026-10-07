import type { Response } from "express";
import type { K8sApi, LogStream } from "../../contracts/k8s.js";
import type { LogLines } from "../../contracts/workloads.js";
import { HttpError } from "../../runtime/http.js";
import { errorMessage } from "../../runtime/log.js";
import type { Browser } from "./browser.js";
import { createRedactor, secretValues, type Redactor } from "./redact.js";
import type { Pod } from "./views.js";

export const DEFAULT_TAIL = 500;
export const DEFAULT_FOLLOW_TAIL = 100;
export const MAX_TAIL = 5000;
// One runaway line (a minified JSON dump) must not become the whole response.
export const MAX_LINE = 16 * 1024;
const HEARTBEAT_MS = 25_000;

export function parseTail(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "tail must be a positive whole number.");
  return Math.min(n, MAX_TAIL);
}

function clip(line: string): string {
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)} …[line cut at ${MAX_LINE} characters]` : line;
}

// Defaults to the first container, as kubectl does; anything else must be
// one the pod actually has.
export function pickContainer(pod: Pod, requested: string | undefined): string {
  const names = [...(pod.spec?.containers ?? []), ...(pod.spec?.initContainers ?? [])].map((c) => c.name);
  if (requested === undefined || requested === "") {
    const first = names[0];
    if (!first) throw new HttpError(400, `Pod "${pod.metadata.name}" has no containers.`);
    return first;
  }
  if (!names.includes(requested)) {
    throw new HttpError(404, `Pod "${pod.metadata.name}" has no container "${requested}".`);
  }
  return requested;
}

function logError(err: unknown, pod: string): HttpError {
  if (err instanceof HttpError) return err;
  const status = (err as { statusCode?: unknown }).statusCode;
  if (status === 403) return new HttpError(403, "Not allowed to read logs: the service account needs get on pods/log.");
  if (status === 404) return new HttpError(404, `Pod "${pod}" not found.`);
  // 400 is the API server explaining itself: container not started yet, no
  // previous instance to read.
  if (status === 400) return new HttpError(400, errorMessage(err));
  return new HttpError(502, `Could not read the log: ${errorMessage(err)}`);
}

async function redactorFor(k8s: K8sApi, pod: Pod): Promise<Redactor> {
  return createRedactor(await secretValues(k8s, pod));
}

export async function readLogs(
  k8s: K8sApi,
  browser: Browser,
  namespace: string,
  name: string,
  query: { container?: string; tail?: string; previous?: string }
): Promise<LogLines> {
  const pod = await browser.rawPod(namespace, name);
  const container = pickContainer(pod, query.container);
  const tail = parseTail(query.tail, DEFAULT_TAIL);
  const redact = await redactorFor(k8s, pod);
  const lines: string[] = [];
  let redacted = 0;
  try {
    const stream = await k8s.logs(
      namespace,
      name,
      { container, tailLines: tail, previous: query.previous === "1" },
      (raw) => {
        const out = redact(clip(raw));
        if (out.redacted) redacted++;
        lines.push(out.line);
      }
    );
    await stream.done;
  } catch (err) {
    throw logError(err, name);
  }
  return { lines, redacted, truncated: lines.length >= tail };
}

// Server-sent events, one `data:` per line. Ends when the container stops,
// the pod goes away, or the browser closes the connection.
export async function followLogs(
  k8s: K8sApi,
  browser: Browser,
  namespace: string,
  name: string,
  query: { container?: string; tail?: string },
  res: Response
): Promise<void> {
  const pod = await browser.rawPod(namespace, name);
  const container = pickContainer(pod, query.container);
  const tail = parseTail(query.tail, DEFAULT_FOLLOW_TAIL);
  const redact = await redactorFor(k8s, pod);

  let closed = false;
  let stream: LogStream | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const finish = () => {
    if (heartbeat) clearInterval(heartbeat);
    stream?.stop();
    if (!res.writableEnded) res.end();
  };
  res.on("close", () => {
    closed = true;
    finish();
  });

  const send = (raw: string) => {
    if (closed || !res.headersSent) return;
    res.write(`data: ${JSON.stringify({ line: redact(clip(raw)).line })}\n\n`);
  };
  // Lines that arrive before the headers go out are held, not dropped.
  const early: string[] = [];
  try {
    stream = await k8s.logs(namespace, name, { container, tailLines: tail, follow: true }, (line) => {
      if (res.headersSent) send(line);
      else early.push(line);
    });
  } catch (err) {
    throw logError(err, name);
  }
  if (closed) {
    stream.stop();
    return;
  }

  res.status(200).set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // nginx-style proxies buffer a response unless told not to.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  for (const line of early) send(line);
  heartbeat = setInterval(() => {
    if (!closed) res.write(": keep-alive\n\n");
  }, HEARTBEAT_MS);
  void stream.done.then(finish, finish);
}

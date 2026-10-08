// A fetch and EventSource stand-in for the deploy and catalog routes,
// answering from apiMocks unless a test overrides a route.
import { vi } from "vitest";
import type { RouteKey } from "@contracts/api";
import { apiMocks } from "../../mocks/api";

type Handler = (url: URL, body: unknown) => unknown;

export interface StubCall {
  key: string;
  url: URL;
  body: unknown;
}

const PATTERNS = (Object.keys(apiMocks) as RouteKey[]).map((key) => {
  const [method, path] = key.split(" ") as [string, string];
  return { key, method, pattern: new RegExp(`${path.replace(/:[A-Za-z]+/g, "[^/]+")}$`) };
});

function match(method: string, url: URL): RouteKey | undefined {
  return PATTERNS.find((r) => r.method === method && r.pattern.test(url.pathname))?.key;
}

export function stubApi(overrides: Partial<Record<RouteKey, unknown | Handler>> = {}) {
  const calls: StubCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const key = match(method, url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ key: key ?? `${method} ${url.pathname}`, url, body });
    if (!key) return new Response(JSON.stringify({ error: "no mock" }), { status: 404 });
    const override = overrides[key];
    let payload: unknown;
    try {
      payload =
        typeof override === "function"
          ? (override as Handler)(url, body)
          : override !== undefined
            ? override
            : structuredClone(apiMocks[key]);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      return new Response(JSON.stringify({ error: (err as Error).message }), { status });
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

// Streams the given lines on open, then reports the stream as ended.
export function stubEventSource(lines: string[] = apiMocks["GET /api/deploy/jobs/:id/logs/stream"].map((e) => e.line)) {
  const opened: string[] = [];
  class FakeEventSource {
    private listeners: Record<string, Array<(event: MessageEvent<string>) => void>> = {};
    constructor(url: string | URL) {
      opened.push(String(url));
      setTimeout(() => {
        for (const line of lines) this.emit("message", JSON.stringify({ line }));
      }, 0);
    }
    addEventListener(type: string, fn: (event: MessageEvent<string>) => void) {
      (this.listeners[type] ??= []).push(fn);
    }
    close() {
      this.listeners = {};
    }
    private emit(type: string, data: string) {
      for (const fn of this.listeners[type] ?? []) fn({ data } as MessageEvent<string>);
    }
  }
  vi.stubGlobal("EventSource", FakeEventSource);
  return { opened };
}

import { useCallback, useEffect, useState } from "react";
import type { ApiMocks, RouteKey } from "@contracts/api";
import { mockFetch } from "../../ui/mocks/api";

// VITE_MOCK_API=1 serves the contract mocks instead, for working on these
// pages with no server running.
const useMocks = import.meta.env.VITE_MOCK_API === "1";

async function request<T>(method: "GET" | "POST", path: string): Promise<T> {
  // Relative to the document, so it works under any path prefix.
  const res = await fetch(new URL(path, document.baseURI), { method, headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export function call<K extends RouteKey>(key: K, path: string): Promise<ApiMocks[K]> {
  if (useMocks) return mockFetch(key);
  return request<ApiMocks[K]>(key.startsWith("POST ") ? "POST" : "GET", path);
}

export interface Loaded<T> {
  data?: T;
  error?: string;
  loading: boolean;
  reload(): void;
}

// Fetches on mount and every `refreshMs`, keeping the last good data while a
// refresh is in flight or has failed.
export function useApi<K extends RouteKey>(key: K, path: string, refreshMs = 15_000): Loaded<ApiMocks[K]> {
  const [state, setState] = useState<Omit<Loaded<ApiMocks[K]>, "reload">>({ loading: true });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      call(key, path).then(
        (data) => !cancelled && setState({ data, loading: false }),
        (err: Error) => !cancelled && setState((prev) => ({ ...prev, loading: false, error: err.message }))
      );
    void load();
    const timer = setInterval(load, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key, path, refreshMs, tick]);

  return { ...state, reload };
}

import { useEffect, useMemo, useState } from "react";
import { RANGE_MS, type ChartRange, type SeriesSelector, type SeriesState, type UseSeries } from "./contracts";
import { useSeriesFetcher } from "./series";

const REFRESH_MS: Record<ChartRange, number> = { "1h": 15_000, "24h": 60_000, "7d": 300_000, "30d": 900_000 };

export const useSeries: UseSeries = (queries: SeriesSelector[], range: ChartRange): SeriesState => {
  const fetcher = useSeriesFetcher();
  // Callers usually pass a fresh array literal each render; keyed on its
  // content so that doesn't refetch on every render.
  const key = useMemo(() => JSON.stringify(queries), [queries]);
  const [state, setState] = useState<SeriesState>({ data: [], loading: true });

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const controller = new AbortController();
    const selectors = JSON.parse(key) as SeriesSelector[];

    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      const to = Date.now();
      try {
        const data = await fetcher(
          selectors.map((s) => ({ ...s, from: to - RANGE_MS[range], to })),
          controller.signal
        );
        if (!cancelled) setState({ data, loading: false });
      } catch (err) {
        if (cancelled || (err as Error)?.name === "AbortError") return;
        // The last good data stays on screen with the error beside it.
        setState((prev) => ({ data: prev.data, loading: false, error: (err as Error).message }));
      } finally {
        inFlight = false;
      }
    };

    setState((prev) => ({ data: prev.data, loading: true }));
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS[range]);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [key, range, fetcher]);

  return state;
};

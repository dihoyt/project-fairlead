import { createContext, useContext, type ReactNode } from "react";
import type { SeriesQuery, SeriesResult } from "@contracts/metrics";
import { apiRequest } from "./api";

// Where useSeries gets its data. The real one asks the metrics query API;
// the components page and tests swap in mock data for a subtree.
export type SeriesFetcher = (queries: SeriesQuery[], signal: AbortSignal) => Promise<SeriesResult[]>;

export const httpSeriesFetcher: SeriesFetcher = (queries, signal) =>
  apiRequest("GET /api/metrics/query", { query: { q: JSON.stringify(queries) }, signal });

const SeriesFetcherContext = createContext<SeriesFetcher>(httpSeriesFetcher);

export function SeriesSourceProvider({ fetcher, children }: { fetcher: SeriesFetcher; children: ReactNode }) {
  return <SeriesFetcherContext.Provider value={fetcher}>{children}</SeriesFetcherContext.Provider>;
}

export function useSeriesFetcher(): SeriesFetcher {
  return useContext(SeriesFetcherContext);
}

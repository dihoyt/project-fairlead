import { mockSeries } from "@contracts/mocks/metrics";
import type { SeriesFetcher } from "./series";

// For <SeriesSourceProvider fetcher={mockSeriesFetcher}>: every shared chart
// below it draws the contract's deterministic mock data instead of calling
// the metrics API.
export const mockSeriesFetcher: SeriesFetcher = async (queries) => queries.flatMap((q) => mockSeries(q));

import { mockSeries } from "@contracts/mocks/metrics";
import { RANGE_MS, type ChartRange, type SeriesSelector, type SeriesState, type UseSeries } from "../contracts";

// Deterministic data for the range ending now, same shapes as the real hook.
export const useMockSeries: UseSeries = (queries: SeriesSelector[], range: ChartRange): SeriesState => {
  const to = Date.now();
  const from = to - RANGE_MS[range];
  return { data: queries.flatMap((q) => mockSeries({ ...q, from, to })), loading: false };
};

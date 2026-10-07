// The shared UI contract: S3 implements these in client/src/ui/, every
// client module consumes them. Changing one is a contract change.
import type { ComponentType, ReactNode } from "react";
import type { CheckResult, Status } from "@contracts/health";
import type { SeriesQuery, SeriesResult } from "@contracts/metrics";

export type { CheckResult, SeriesQuery, SeriesResult, Status };

export type ChartRange = "1h" | "24h" | "7d" | "30d";

export const RANGE_MS: Record<ChartRange, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

export type ChartUnit = "percent" | "bytes" | "bytesPerSec" | "count" | "celsius";

// A series to fetch; the time window comes from the range the component is given.
export type SeriesSelector = Omit<SeriesQuery, "from" | "to">;

export interface TileProps {
  title: string;
  status: Status;
  summary: string;
  count?: { warn: number; crit: number };
  // In-app route the tile links to, e.g. "/health/cluster".
  to?: string;
}

export interface StatusBadgeProps {
  status: Status;
  // Defaults to the status name.
  label?: string;
}

export interface CheckListProps {
  results: CheckResult[];
  // When to show a result's raw data. Default "failures": the UX rule is
  // that a failing check always shows what it was judged on.
  showRaw?: "failures" | "always" | "never";
}

export interface TimeSeriesChartProps {
  queries: SeriesSelector[];
  range: ChartRange;
  unit: ChartUnit;
  height?: number;
  // Legend label per result; default joins the result's label values.
  label?: (result: SeriesResult) => string;
}

export interface SparklineProps {
  query: SeriesSelector;
  range: Extract<ChartRange, "1h" | "24h">;
  unit?: ChartUnit;
}

export interface SeriesState {
  data: SeriesResult[];
  loading: boolean;
  error?: string;
}

// Fetches GET /api/metrics/query for the range ending now, refetching on an
// interval suited to the range. Results keep the order of the selectors.
export type UseSeries = (queries: SeriesSelector[], range: ChartRange) => SeriesState;

// --- Client modules -------------------------------------------------------
// client/src/modules/<name>/index.tsx exports `navItems` and `routes`; App
// collects every module with import.meta.glob, so adding one edits no
// shared file.

export interface NavItem {
  label: string;
  // Hash route: "/health".
  to: string;
  icon?: ComponentType<{ size?: number | string; stroke?: number }>;
  // Lower sorts first; default 100.
  order?: number;
  section?: "main" | "admin";
}

export interface ModuleRoute {
  // Matched under the HashRouter: "/health", "/health/:category".
  path: string;
  element: ReactNode;
}

// A page the shell opens once per browser session for an admin, after
// sign-in, while the module says it still needs doing.
export interface FirstRunStep {
  // Hash route the shell navigates to: "/welcome".
  path: string;
  // Resolves true while the step is outstanding. A rejection counts as
  // false, so a failing check never traps anyone on the page.
  isPending: () => Promise<boolean>;
}

export interface ClientModule {
  navItems: NavItem[];
  routes: ModuleRoute[];
  // Exported as `firstRun` beside navItems and routes. Modules are checked
  // in folder order and the first pending step wins.
  firstRun?: FirstRunStep;
}

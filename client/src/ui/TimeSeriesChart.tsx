import { LineChart } from "@mantine/charts";
import { Center, Skeleton, Stack, Text } from "@mantine/core";
import type { SeriesResult } from "@contracts/metrics";
import type { ChartRange, TimeSeriesChartProps } from "./contracts";
import { formatValue } from "./format";
import { useSeries } from "./useSeries";

const COLORS = ["cyan.6", "teal.6", "grape.6", "orange.6", "indigo.6", "lime.6", "pink.6", "yellow.6"];

const defaultLabel = (result: SeriesResult) => Object.values(result.labels).join(" ") || result.series;

export function formatTick(ts: number, range: ChartRange): string {
  const date = new Date(ts);
  return range === "1h" || range === "24h"
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

// One row per timestamp with a column per series, the shape the chart
// takes. Series sampled at different instants leave gaps, which the chart
// connects.
export function toRows(data: SeriesResult[], names: string[]): Array<Record<string, number>> {
  const rows = new Map<number, Record<string, number>>();
  data.forEach((result, i) => {
    for (const [ts, value] of result.points) {
      const row = rows.get(ts) ?? { ts };
      row[names[i]!] = value;
      rows.set(ts, row);
    }
  });
  return [...rows.values()].toSorted((a, b) => a.ts! - b.ts!);
}

// Two series with identical labels would collide as columns.
function uniqueNames(data: SeriesResult[], label: (r: SeriesResult) => string): string[] {
  const seen = new Map<string, number>();
  return data.map((result) => {
    const base = label(result);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

export function TimeSeriesChart({ queries, range, unit, height = 220, label = defaultLabel }: TimeSeriesChartProps) {
  const { data, loading, error } = useSeries(queries, range);
  if (loading && data.length === 0) return <Skeleton h={height} />;

  const names = uniqueNames(data, label);
  const rows = toRows(data, names);
  if (rows.length === 0) {
    return (
      <Center h={height} bd="1px dashed var(--mantine-color-default-border)">
        <Text size="sm" c={error ? "red" : "dimmed"}>
          {error ?? "No data for this range yet."}
        </Text>
      </Center>
    );
  }

  return (
    <Stack gap={4}>
      <LineChart
        h={height}
        data={rows}
        dataKey="ts"
        series={names.map((name, i) => ({ name, color: COLORS[i % COLORS.length]! }))}
        withDots={false}
        withLegend={names.length > 1}
        legendProps={{ verticalAlign: "bottom", height: 40 }}
        curveType="monotone"
        strokeWidth={1.5}
        valueFormatter={(value) => formatValue(value, unit)}
        xAxisProps={{
          type: "number",
          scale: "time",
          domain: ["dataMin", "dataMax"],
          tickFormatter: (ts: number) => formatTick(ts, range),
        }}
        yAxisProps={{
          width: 80,
          ...(unit === "percent" ? { domain: [0, 100] } : {}),
        }}
        tooltipProps={{ labelFormatter: (ts) => new Date(Number(ts)).toLocaleString() }}
        tooltipAnimationDuration={100}
      />
      {error ? (
        <Text size="xs" c="red">
          Refresh failed: {error}
        </Text>
      ) : null}
    </Stack>
  );
}

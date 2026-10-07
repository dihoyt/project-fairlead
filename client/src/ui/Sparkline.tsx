import { Sparkline as MantineSparkline } from "@mantine/charts";
import { Group, Skeleton, Text } from "@mantine/core";
import type { SparklineProps } from "./contracts";
import { formatValue } from "./format";
import { useSeries } from "./useSeries";

const WIDTH = 120;
const HEIGHT = 32;

export function Sparkline({ query, range, unit }: SparklineProps) {
  const { data, loading } = useSeries([query], range);
  const points = data[0]?.points.map(([, value]) => value) ?? [];
  if (loading && points.length === 0) return <Skeleton w={WIDTH} h={HEIGHT} />;
  const last = points.at(-1);
  return (
    <Group gap="xs" wrap="nowrap" title={query.series}>
      {points.length > 1 ? (
        <MantineSparkline w={WIDTH} h={HEIGHT} data={points} curveType="monotone" color="cyan" fillOpacity={0.2} />
      ) : (
        <Text w={WIDTH} size="xs" c="dimmed">
          no data
        </Text>
      )}
      {unit && last !== undefined ? (
        <Text size="sm" ff="monospace" style={{ whiteSpace: "nowrap" }}>
          {formatValue(last, unit)}
        </Text>
      ) : null}
    </Group>
  );
}

import { Anchor, Group, SimpleGrid, Stack } from "@mantine/core";
import { IconArrowLeft } from "@tabler/icons-react";
import { Link, useParams } from "react-router";
import type { SeriesResult } from "@contracts/metrics";
import { PageHeader } from "../../shell/PageHeader";
import { TimeSeriesChart } from "../../ui";
import { ChartCard, RangeControl, useRange } from "./shared";

const byContainer = (result: SeriesResult) => result.labels.container ?? result.series;

export function PodPage() {
  const { name = "", namespace = "", pod = "" } = useParams();
  const [range, setRange] = useRange();
  const labels = { namespace, pod };

  return (
    <Stack gap="md">
      <Anchor component={Link} to={`/nodes/${encodeURIComponent(name)}`} size="sm">
        <Group gap={4}>
          <IconArrowLeft size={14} />
          {name}
        </Group>
      </Anchor>
      <PageHeader
        title={pod}
        description={`${namespace} · CPU is a percentage of one core`}
        actions={<RangeControl value={range} onChange={setRange} />}
      />
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <ChartCard title="CPU">
          <TimeSeriesChart
            queries={[{ series: "container.cpu.percent", labels }]}
            range={range}
            unit="percent"
            label={byContainer}
          />
        </ChartCard>
        <ChartCard title="Memory">
          <TimeSeriesChart
            queries={[{ series: "container.memory.bytes", labels }]}
            range={range}
            unit="bytes"
            label={byContainer}
          />
        </ChartCard>
        <ChartCard title="Restarts">
          <TimeSeriesChart
            queries={[{ series: "container.restarts.count", labels }]}
            range={range}
            unit="count"
            label={byContainer}
          />
        </ChartCard>
      </SimpleGrid>
    </Stack>
  );
}

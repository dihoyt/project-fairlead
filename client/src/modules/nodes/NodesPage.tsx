import { Alert, Loader, SimpleGrid, Stack } from "@mantine/core";
import type { SeriesResult } from "@contracts/metrics";
import { PageHeader } from "../../shell/PageHeader";
import { Tile, TimeSeriesChart, useApi, useSession } from "../../ui";
import { RaiseReplicas } from "../../ui/deploy";
import { AddNode } from "./AddNode";
import { DefaultStorageClass } from "./StorageClass";
import { ChartCard, RangeControl, nodeLine, nodeStatus, useRange } from "./shared";

const byNode = (result: SeriesResult) => result.labels.node ?? result.series;

export function NodesPage() {
  const { me } = useSession();
  const [range, setRange] = useRange();
  const { data, error, loading } = useApi("GET /api/metrics-k8s/nodes", undefined, { pollMs: 30_000 });

  return (
    <Stack gap="md">
      <PageHeader
        title="Nodes"
        description="Usage from each node's kubelet, read through the API server."
        actions={<RangeControl value={range} onChange={setRange} />}
      />
      <DefaultStorageClass />
      <RaiseReplicas />
      {error ? (
        <Alert color="red" title="Could not load nodes">
          {error}
        </Alert>
      ) : null}
      {loading && !data ? <Loader size="sm" /> : null}
      {data ? (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
          {data.map((node) => (
            <Tile
              key={node.name}
              title={node.name}
              status={nodeStatus(node)}
              summary={nodeLine(node)}
              to={`/nodes/${encodeURIComponent(node.name)}`}
            />
          ))}
        </SimpleGrid>
      ) : null}
      <AddNode canCreate={me.admin} />
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <ChartCard title="CPU">
          <TimeSeriesChart queries={[{ series: "node.cpu.percent" }]} range={range} unit="percent" label={byNode} />
        </ChartCard>
        <ChartCard title="Memory">
          <TimeSeriesChart queries={[{ series: "node.memory.percent" }]} range={range} unit="percent" label={byNode} />
        </ChartCard>
        <ChartCard title="Filesystem">
          <TimeSeriesChart queries={[{ series: "node.fs.percent" }]} range={range} unit="percent" label={byNode} />
        </ChartCard>
        <ChartCard title="Network receive">
          <TimeSeriesChart
            queries={[{ series: "node.net.rx.bytesPerSec" }]}
            range={range}
            unit="bytesPerSec"
            label={byNode}
          />
        </ChartCard>
      </SimpleGrid>
    </Stack>
  );
}

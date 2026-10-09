import { useMemo } from "react";
import { Alert, Anchor, Badge, Card, Group, SimpleGrid, Stack, Table, Text } from "@mantine/core";
import { IconArrowLeft } from "@tabler/icons-react";
import { Link, useParams } from "react-router";
import type { SeriesResult } from "@contracts/metrics";
import { PageHeader } from "../../shell/PageHeader";
import { StatusBadge, TimeSeriesChart, formatValue, useApi, useSeries } from "../../ui";
import { ChartCard, RangeControl, SOURCE_LABEL, nodeStatus, useRange, type NodeRange } from "./shared";

interface ContainerRow {
  namespace: string;
  pod: string;
  container: string;
  cpu?: number;
  memory?: number;
  restarts?: number;
}

const direction = (result: SeriesResult) => (result.series.includes(".rx.") ? "receive" : "transmit");
const latest = (result: SeriesResult) => result.points.at(-1)?.[1];

// The newest value of each container series on this node, one row per container.
function useContainers(node: string): { rows: ContainerRow[]; loading: boolean; error?: string } {
  const { data, loading, error } = useSeries(
    [
      { series: "container.cpu.percent", labels: { node } },
      { series: "container.memory.bytes", labels: { node } },
      { series: "container.restarts.count", labels: { node } },
    ],
    "1h"
  );
  const rows = useMemo(() => {
    const byKey = new Map<string, ContainerRow>();
    for (const result of data) {
      const { namespace = "", pod = "", container = "" } = result.labels;
      if (!pod) continue;
      const key = `${namespace}/${pod}/${container}`;
      const row = byKey.get(key) ?? { namespace, pod, container };
      const value = latest(result);
      if (result.series === "container.cpu.percent") row.cpu = value;
      else if (result.series === "container.memory.bytes") row.memory = value;
      else row.restarts = value;
      byKey.set(key, row);
    }
    return [...byKey.values()].toSorted((a, b) => (b.memory ?? -1) - (a.memory ?? -1));
  }, [data]);
  return { rows, loading, error };
}

function Containers({ node }: { node: string }) {
  const { rows, loading, error } = useContainers(node);
  return (
    <Card withBorder padding="md">
      <Stack gap="xs">
        <Group justify="space-between">
          <Text size="sm" fw={600}>
            Containers
          </Text>
          <Text size="xs" c="dimmed">
            Latest reading in the last hour
          </Text>
        </Group>
        {error ? (
          <Alert color="red" p="xs">
            {error}
          </Alert>
        ) : null}
        {rows.length === 0 ? (
          <Text size="sm" c="dimmed">
            {loading ? "Loading…" : "No container readings for this node in the last hour."}
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={560}>
            <Table fz="sm" verticalSpacing={4} striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Namespace</Table.Th>
                  <Table.Th>Pod</Table.Th>
                  <Table.Th>Container</Table.Th>
                  <Table.Th ta="right">CPU</Table.Th>
                  <Table.Th ta="right">Memory</Table.Th>
                  <Table.Th ta="right">Restarts</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((row) => (
                  <Table.Tr key={`${row.namespace}/${row.pod}/${row.container}`}>
                    <Table.Td>{row.namespace}</Table.Td>
                    <Table.Td>
                      <Anchor
                        component={Link}
                        to={`/nodes/${encodeURIComponent(node)}/pods/${encodeURIComponent(row.namespace)}/${encodeURIComponent(row.pod)}`}
                        size="sm"
                      >
                        {row.pod}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>{row.container}</Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {row.cpu === undefined ? "–" : formatValue(row.cpu, "percent")}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {row.memory === undefined ? "–" : formatValue(row.memory, "bytes")}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {row.restarts === undefined ? "–" : formatValue(row.restarts, "count")}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Stack>
    </Card>
  );
}

// The node's own charts: CPU, memory, filesystem and network, plus its pod
// count on the node page.
export function NodeCharts({ node, range, pods = false }: { node: string; range: NodeRange; pods?: boolean }) {
  const labels = { node };
  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }}>
      <ChartCard title="CPU">
        <TimeSeriesChart
          queries={[{ series: "node.cpu.percent", labels }]}
          range={range}
          unit="percent"
          label={() => "CPU"}
        />
      </ChartCard>
      <ChartCard title="Memory">
        <TimeSeriesChart
          queries={[{ series: "node.memory.bytes", labels }]}
          range={range}
          unit="bytes"
          label={() => "working set"}
        />
      </ChartCard>
      <ChartCard title="Filesystem">
        <TimeSeriesChart
          queries={[{ series: "node.fs.percent", labels }]}
          range={range}
          unit="percent"
          label={() => "used"}
        />
      </ChartCard>
      <ChartCard title="Network">
        <TimeSeriesChart
          queries={[
            { series: "node.net.rx.bytesPerSec", labels },
            { series: "node.net.tx.bytesPerSec", labels },
          ]}
          range={range}
          unit="bytesPerSec"
          label={direction}
        />
      </ChartCard>
      {pods ? (
        <ChartCard title="Pods">
          <TimeSeriesChart
            queries={[{ series: "node.pods.count", labels }]}
            range={range}
            unit="count"
            label={() => "pods"}
          />
        </ChartCard>
      ) : null}
    </SimpleGrid>
  );
}

export function NodePage() {
  const { name = "" } = useParams();
  const [range, setRange] = useRange();
  const nodes = useApi("GET /api/metrics-k8s/nodes", undefined, { pollMs: 30_000 });
  const summary = nodes.data?.find((n) => n.name === name);

  return (
    <Stack gap="md">
      <Anchor component={Link} to="/nodes" size="sm">
        <Group gap={4}>
          <IconArrowLeft size={14} />
          Nodes
        </Group>
      </Anchor>
      <PageHeader title={name} actions={<RangeControl value={range} onChange={setRange} />} />
      {summary ? (
        <Group gap="xs" mt={-12}>
          <StatusBadge status={nodeStatus(summary)} label={summary.ready ? "Ready" : "Not Ready"} />
          <Badge variant="light" color="gray">
            {SOURCE_LABEL[summary.source]}
          </Badge>
          <Text size="sm" c="dimmed">
            {summary.pods} pods
          </Text>
        </Group>
      ) : null}
      {nodes.error ? (
        <Alert color="red" title="Could not load the node">
          {nodes.error}
        </Alert>
      ) : null}
      {nodes.data && !summary ? (
        <Alert color="yellow">The cluster does not list a node named {name}; showing what was recorded.</Alert>
      ) : null}
      <NodeCharts node={name} range={range} pods />
      <Containers node={name} />
    </Stack>
  );
}

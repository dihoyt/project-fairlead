import { useState, type ReactNode } from "react";
import {
  Code,
  Group,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  Title,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import { CATEGORIES, type Status } from "@contracts/health";
import { mockCheckResultList } from "@contracts/mocks/health";
import { CheckList } from "../../ui/CheckList";
import type { ChartRange, TileProps } from "../../ui/contracts";
import { apiMocks } from "../../ui/mocks/api";
import { mockSeriesFetcher } from "../../ui/mockSeriesFetcher";
import { SeriesSourceProvider } from "../../ui/series";
import { Sparkline } from "../../ui/Sparkline";
import { StatusBadge } from "../../ui/StatusBadge";
import { Tile } from "../../ui/Tile";
import { TimeSeriesChart } from "../../ui/TimeSeriesChart";
import { PageHeader } from "../PageHeader";

const STATUSES: Status[] = ["ok", "warn", "crit", "unknown", "absent"];

const title = (category: string) => category[0]!.toUpperCase() + category.slice(1);

// The health board mock, in the shape a tile takes.
const tiles: TileProps[] = apiMocks["GET /api/health/board"].tiles.map((tile) => ({
  title: title(tile.category),
  status: tile.status,
  summary: tile.summary,
  count: { warn: tile.counts.warn, crit: tile.counts.crit },
  to: `/health/${tile.category}`,
}));

function Section({ name, usage, children }: { name: string; usage: string; children: ReactNode }) {
  return (
    <Paper withBorder p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="baseline" wrap="wrap">
          <Title order={4}>{name}</Title>
          <Code fz="xs">{usage}</Code>
        </Group>
        {children}
      </Stack>
    </Paper>
  );
}

// Every shared component on mock data, so a module can be designed before
// its API exists and checked in both color schemes.
export function ComponentsPage() {
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme("dark");
  const [range, setRange] = useState<ChartRange>("24h");

  return (
    <SeriesSourceProvider fetcher={mockSeriesFetcher}>
      <PageHeader
        title="Components"
        description={
          <>
            The shared UI in <Code>client/src/ui</Code>, drawn from <Code>@contracts/mocks</Code>. Charts here never
            call the metrics API.
          </>
        }
        actions={
          <SegmentedControl
            size="xs"
            value={scheme}
            onChange={(value) => setColorScheme(value as "light" | "dark")}
            data={[
              { label: "Dark", value: "dark" },
              { label: "Light", value: "light" },
            ]}
          />
        }
      />
      <Stack gap="lg">
        <Section name="StatusBadge" usage="<StatusBadge status label? />">
          <Group gap="xs">
            {STATUSES.map((status) => (
              <StatusBadge key={status} status={status} />
            ))}
            <StatusBadge status="warn" label="3 stale" />
          </Group>
        </Section>

        <Section name="Tile" usage="<Tile title status summary count? to? />">
          <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }} spacing="md">
            {tiles.map((tile) => (
              <Tile key={tile.title} {...tile} />
            ))}
          </SimpleGrid>
          <Text size="xs" c="dimmed">
            Categories: {CATEGORIES.join(", ")}.
          </Text>
        </Section>

        <Section name="CheckList" usage='<CheckList results showRaw?="failures" />'>
          <CheckList results={mockCheckResultList} />
        </Section>

        <Section name="TimeSeriesChart" usage="<TimeSeriesChart queries range unit height? label? />">
          <SegmentedControl
            size="xs"
            w="fit-content"
            value={range}
            onChange={(value) => setRange(value as ChartRange)}
            data={["1h", "24h", "7d", "30d"]}
          />
          <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                Node CPU (percent, one line per node)
              </Text>
              <TimeSeriesChart queries={[{ series: "node.cpu.percent" }]} range={range} unit="percent" />
            </Stack>
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                Node receive (bytesPerSec)
              </Text>
              <TimeSeriesChart queries={[{ series: "node.net.rx.bytesPerSec" }]} range={range} unit="bytesPerSec" />
            </Stack>
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                Container memory (bytes)
              </Text>
              <TimeSeriesChart
                queries={[{ series: "container.memory.bytes", labels: { namespace: "media", pod: "jellyfin" } }]}
                range={range}
                unit="bytes"
                label={(r) => r.labels.pod ?? r.series}
              />
            </Stack>
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                Host temperature (celsius)
              </Text>
              <TimeSeriesChart
                queries={[{ series: "host.temp.celsius", labels: { host: "nas" } }]}
                range={range}
                unit="celsius"
              />
            </Stack>
          </SimpleGrid>
        </Section>

        <Section name="Sparkline" usage="<Sparkline query range unit? />">
          <Stack gap="xs">
            {["node-1", "node-2", "node-3"].map((node) => (
              <Group key={node} gap="md">
                <Text size="sm" w={80}>
                  {node}
                </Text>
                <Sparkline query={{ series: "node.cpu.percent", labels: { node } }} range="1h" unit="percent" />
                <Sparkline query={{ series: "node.memory.percent", labels: { node } }} range="24h" unit="percent" />
              </Group>
            ))}
          </Stack>
        </Section>
      </Stack>
    </SeriesSourceProvider>
  );
}

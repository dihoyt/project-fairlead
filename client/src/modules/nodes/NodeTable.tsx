import { Fragment, useState, type ReactNode } from "react";
import { Sparkline as MantineSparkline } from "@mantine/charts";
import { Anchor, Badge, Box, Group, Stack, Table, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { Link } from "react-router";
import type { NodeSparkMetric, NodeSummary } from "@contracts/metrics";
import { StatusBadge, formatValue, type ChartUnit, type Status } from "../../ui";
import { NodeActions } from "./NodeActions";
import { NodeCharts } from "./NodePage";
import type { NodeRange } from "./shared";

const SPARK_W = 44;
const SPARK_H = 22;

interface MetricColumn {
  metric: NodeSparkMetric;
  label: string;
  unit: ChartUnit | "load";
  current(node: NodeSummary): number | undefined;
}

const METRICS: MetricColumn[] = [
  { metric: "cpu", label: "CPU", unit: "percent", current: (n) => n.cpuPercent },
  { metric: "memory", label: "Memory", unit: "percent", current: (n) => n.memoryPercent },
  { metric: "filesystem", label: "Disk", unit: "percent", current: (n) => n.filesystemPercent },
  { metric: "netRx", label: "Net in", unit: "bytesPerSec", current: (n) => n.netRxBps },
  { metric: "netTx", label: "Net out", unit: "bytesPerSec", current: (n) => n.netTxBps },
  { metric: "load", label: "Load", unit: "load", current: (n) => n.load1 },
];

const format = (value: number, unit: MetricColumn["unit"]) =>
  unit === "load" ? value.toFixed(2) : formatValue(value, unit);

export function nodeState(node: NodeSummary): { status: Status; label: string } {
  if (!node.ready) return { status: "crit", label: "Not Ready" };
  if (node.schedulable === false) return { status: "warn", label: "Cordoned" };
  return { status: "ok", label: "Ready" };
}

export function uptime(bootTime: string | undefined, now = Date.now()): string | undefined {
  const at = bootTime ? Date.parse(bootTime) : NaN;
  if (!Number.isFinite(at)) return undefined;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function SparkCell({ node, column }: { node: NodeSummary; column: MetricColumn }) {
  const points = node.spark?.[column.metric] ?? [];
  const values = points.filter((v): v is number => v !== null);
  const current = column.current(node) ?? values.at(-1);
  if (current === undefined && values.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        –
      </Text>
    );
  }
  return (
    <Group gap={6} wrap="nowrap">
      {values.length > 1 ? (
        <MantineSparkline
          w={SPARK_W}
          h={SPARK_H}
          // Gaps are drawn flat at the last value rather than as zeros.
          data={points.map((v, i) => v ?? points.slice(0, i).findLast((p) => p !== null) ?? values[0]!)}
          curveType="monotone"
          color="cyan"
          fillOpacity={0.2}
        />
      ) : (
        <Box w={SPARK_W} />
      )}
      <Text size="xs" ff="monospace" style={{ whiteSpace: "nowrap" }}>
        {current === undefined ? "–" : format(current, column.unit)}
      </Text>
    </Group>
  );
}

function NameCell({ node, open }: { node: NodeSummary; open: boolean }) {
  const Chevron = open ? IconChevronDown : IconChevronRight;
  return (
    <Group gap={6} wrap="nowrap">
      <Chevron size={14} aria-hidden />
      <Stack gap={0}>
        <Text size="sm" fw={600} style={{ whiteSpace: "nowrap" }}>
          {node.name}
        </Text>
        {node.roles?.length ? (
          <Text size="xs" c="dimmed">
            {node.roles.join(", ")}
          </Text>
        ) : null}
      </Stack>
    </Group>
  );
}

function StateCell({ node }: { node: NodeSummary }) {
  const state = nodeState(node);
  const pressure = node.pressure ?? [];
  return (
    <Group gap={6} wrap="nowrap">
      <Box style={{ flexShrink: 0 }}>
        <StatusBadge status={state.status} label={state.label} />
      </Box>
      {pressure.length > 0 ? (
        <Tooltip label={pressure.join(", ")}>
          <Box
            role="img"
            aria-label={`Pressure: ${pressure.join(", ")}`}
            w={8}
            h={8}
            bg="yellow"
            style={{ borderRadius: "50%", flexShrink: 0 }}
          />
        </Tooltip>
      ) : null}
    </Group>
  );
}

function VersionCell({ node }: { node: NodeSummary }) {
  if (!node.kubeletVersion)
    return (
      <Text size="xs" c="dimmed">
        –
      </Text>
    );
  return (
    <Group gap={6} wrap="nowrap">
      <Text size="xs" ff="monospace" style={{ whiteSpace: "nowrap" }}>
        {node.kubeletVersion}
      </Text>
      {node.versionDrift ? (
        <Tooltip label="The kubelet runs a different version from the API server.">
          <Badge size="xs" color="yellow" variant="light" style={{ flexShrink: 0, overflow: "visible" }}>
            drift
          </Badge>
        </Tooltip>
      ) : null}
    </Group>
  );
}

function Cell({ children }: { children: ReactNode }) {
  return <Table.Td style={{ whiteSpace: "nowrap" }}>{children}</Table.Td>;
}

export function NodeTable({
  nodes,
  range,
  onChanged,
}: {
  nodes: NodeSummary[];
  range: NodeRange;
  // After a node action finishes, to read the node's new state.
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState<string | undefined>();
  const longhorn = nodes.some((n) => n.longhornAvailableBytes !== undefined);
  const metrics = nodes.some((n) => n.load1 !== undefined || n.spark?.load) ? METRICS : METRICS.slice(0, -1);
  const columns = 6 + metrics.length + (longhorn ? 1 : 0);
  const toggle = (name: string) => setOpen((current) => (current === name ? undefined : name));

  return (
    <Table.ScrollContainer minWidth={1100}>
      <Table fz="sm" verticalSpacing={6} highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Node</Table.Th>
            <Table.Th>State</Table.Th>
            <Table.Th>Version</Table.Th>
            <Table.Th>Up</Table.Th>
            <Table.Th>Pods</Table.Th>
            {metrics.map((m) => (
              <Table.Th key={m.metric}>{m.label}</Table.Th>
            ))}
            {longhorn ? <Table.Th>Longhorn</Table.Th> : null}
            <Table.Th aria-label="Actions" />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {nodes.map((node) => {
            const expanded = open === node.name;
            return (
              <Fragment key={node.name}>
                <Table.Tr
                  onClick={() => toggle(node.name)}
                  style={{ cursor: "pointer" }}
                  aria-expanded={expanded}
                  data-testid={`node-row-${node.name}`}
                >
                  <Cell>
                    <UnstyledButton
                      aria-label={`${expanded ? "Hide" : "Show"} charts for ${node.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(node.name);
                      }}
                    >
                      <NameCell node={node} open={expanded} />
                    </UnstyledButton>
                  </Cell>
                  <Cell>
                    <StateCell node={node} />
                  </Cell>
                  <Cell>
                    <VersionCell node={node} />
                  </Cell>
                  <Cell>
                    <Text size="sm" ff="monospace">
                      {uptime(node.bootTime) ?? "–"}
                    </Text>
                  </Cell>
                  <Cell>
                    <Text size="sm" ff="monospace">
                      {node.podCapacity !== undefined ? `${node.pods}/${node.podCapacity}` : node.pods}
                    </Text>
                  </Cell>
                  {metrics.map((m) => (
                    <Cell key={m.metric}>
                      <SparkCell node={node} column={m} />
                    </Cell>
                  ))}
                  {longhorn ? (
                    <Cell>
                      <Text size="sm" ff="monospace">
                        {node.longhornAvailableBytes !== undefined
                          ? formatValue(node.longhornAvailableBytes, "bytes")
                          : "–"}
                      </Text>
                    </Cell>
                  ) : null}
                  <Cell>
                    <NodeActions node={node} onDone={onChanged} />
                  </Cell>
                </Table.Tr>
                {expanded ? (
                  <Table.Tr>
                    <Table.Td colSpan={columns} p="md">
                      <Stack gap="sm">
                        <NodeCharts node={node.name} range={range} />
                        <Anchor component={Link} to={`/nodes/${encodeURIComponent(node.name)}`} size="sm">
                          Containers and pods on {node.name}
                        </Anchor>
                      </Stack>
                    </Table.Td>
                  </Table.Tr>
                ) : null}
              </Fragment>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

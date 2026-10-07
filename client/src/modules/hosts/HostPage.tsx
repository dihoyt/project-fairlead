import { useState } from "react";
import {
  Alert,
  Anchor,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { IconArrowLeft, IconPencil, IconTrash } from "@tabler/icons-react";
import { Link, useNavigate, useParams } from "react-router";
import type { HostRequest, HostView } from "@contracts/hosts";
import type { ChartRange, ChartUnit, SeriesResult, SeriesSelector } from "../../ui";
import {
  CheckList,
  StatusBadge,
  TimeSeriesChart,
  apiRequest,
  formatValue,
  relativeTime,
  useApi,
  useSession,
} from "../../ui";
import { HostForm } from "./HostForm";
import { KIND_LABEL, uptime } from "./labels";

interface Chart {
  title: string;
  unit: ChartUnit;
  queries: (host: string) => SeriesSelector[];
  label?: (r: SeriesResult) => string;
}

const byLabel = (key: string) => (r: SeriesResult) => r.labels[key] ?? r.series;

const CHARTS: Chart[] = [
  {
    title: "CPU and memory",
    unit: "percent",
    queries: (host) => [
      { series: "host.cpu.percent", labels: { host } },
      { series: "host.memory.percent", labels: { host } },
    ],
    label: (r) => (r.series === "host.cpu.percent" ? "CPU" : "Memory"),
  },
  {
    title: "Disk space used",
    unit: "percent",
    queries: (host) => [
      { series: "host.disk.percent", labels: { host } },
      { series: "host.pool.percent", labels: { host } },
    ],
    label: (r) => r.labels.mount ?? `pool ${r.labels.pool ?? ""}`,
  },
  {
    title: "Network received",
    unit: "bytesPerSec",
    queries: (host) => [{ series: "host.net.rx.bytesPerSec", labels: { host } }],
    label: byLabel("iface"),
  },
  {
    title: "Network sent",
    unit: "bytesPerSec",
    queries: (host) => [{ series: "host.net.tx.bytesPerSec", labels: { host } }],
    label: byLabel("iface"),
  },
  {
    title: "Temperatures",
    unit: "celsius",
    queries: (host) => [{ series: "host.temp.celsius", labels: { host } }],
    label: byLabel("sensor"),
  },
  {
    title: "Load (1 minute)",
    unit: "count",
    queries: (host) => [{ series: "host.load", labels: { host } }],
    label: () => "load",
  },
];

function Facts({ host }: { host: HostView }) {
  const facts = host.facts ?? {};
  const rows: Array<[string, string | undefined]> = [
    ["Address", `${host.username}@${host.address}:${host.port}`],
    ["Kind", host.detectedKind ? KIND_LABEL[host.detectedKind] : KIND_LABEL[host.kind]],
    ["System", facts.os],
    ["Hostname", facts.hostname],
    ["Kernel", facts.kernel],
    ["CPUs", facts.cpus?.toString()],
    ["Memory", facts.memoryBytes ? formatValue(facts.memoryBytes, "bytes") : undefined],
    ["Uptime", facts.uptimeSeconds !== undefined ? uptime(facts.uptimeSeconds).replace(/^up /, "") : undefined],
    ["Signs in with", host.auth === "key" ? "Private key" : "Password"],
    ["Backup targets", host.backupTargetPaths.join(", ") || undefined],
    ["Last seen", relativeTime(host.lastSeenAt)],
  ];
  return (
    <Table withRowBorders={false} verticalSpacing={4}>
      <Table.Tbody>
        {rows
          .filter(([, value]) => value)
          .map(([name, value]) => (
            <Table.Tr key={name}>
              <Table.Td w={140}>
                <Text size="sm" c="dimmed">
                  {name}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{value}</Text>
              </Table.Td>
            </Table.Tr>
          ))}
      </Table.Tbody>
    </Table>
  );
}

export function HostPage() {
  const { id = "" } = useParams();
  const { me } = useSession();
  const navigate = useNavigate();
  const host = useApi("GET /api/hosts/:id", { params: { id } }, { pollMs: 15_000 });
  const health = useApi("GET /api/health/categories/:category", { params: { category: "hosts" } }, { pollMs: 30_000 });
  const [range, setRange] = useState<ChartRange>("24h");
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();

  const results = (health.data?.providers ?? [])
    .filter((p) => p.id === "hosts")
    .flatMap((p) => p.results)
    .filter((r) => r.id.startsWith(`${id}.`));

  async function save(req: HostRequest) {
    await apiRequest("PUT /api/hosts/:id", { params: { id }, body: req });
    setEditing(false);
    host.reload();
  }

  async function remove() {
    try {
      await apiRequest("DELETE /api/hosts/:id", { params: { id } });
      void navigate("/hosts");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  }

  if (!host.data) {
    return host.error ? (
      <Alert color="red" variant="light">
        {host.error}
      </Alert>
    ) : (
      <Loader />
    );
  }
  const h = host.data;

  return (
    <Stack>
      <Anchor component={Link} to="/hosts" size="sm">
        <Group gap={4}>
          <IconArrowLeft size={14} /> Hosts
        </Group>
      </Anchor>
      <Group justify="space-between">
        <Group gap="sm">
          <Title order={2}>{h.label}</Title>
          <StatusBadge status={h.status} />
        </Group>
        {me.admin && (
          <Group gap="xs">
            <Button variant="default" leftSection={<IconPencil size={16} />} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              variant="subtle"
              color="red"
              leftSection={<IconTrash size={16} />}
              onClick={() => setDeleting(true)}
            >
              Delete
            </Button>
          </Group>
        )}
      </Group>

      {(error || h.lastError) && (
        <Alert color="red" variant="light">
          {error ?? h.lastError}
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Card withBorder>
          <Text fw={600} mb="xs">
            System
          </Text>
          <Facts host={h} />
        </Card>
        <Card withBorder>
          <Text fw={600} mb="xs">
            Checks
          </Text>
          {health.data ? <CheckList results={results} /> : <Loader size="sm" />}
        </Card>
      </SimpleGrid>

      <Group justify="space-between">
        <Title order={4}>History</Title>
        <SegmentedControl
          size="xs"
          value={range}
          onChange={(v) => setRange(v as ChartRange)}
          data={["1h", "24h", "7d", "30d"]}
        />
      </Group>
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        {CHARTS.map((chart) => (
          <Card withBorder key={chart.title}>
            <Text fw={600} size="sm" mb="xs">
              {chart.title}
            </Text>
            <TimeSeriesChart
              queries={chart.queries(id)}
              range={range}
              unit={chart.unit}
              height={180}
              {...(chart.label ? { label: chart.label } : {})}
            />
          </Card>
        ))}
      </SimpleGrid>

      <Modal opened={editing} onClose={() => setEditing(false)} title={`Edit ${h.label}`} size="lg">
        {editing && <HostForm host={h} onSubmit={save} onCancel={() => setEditing(false)} />}
      </Modal>

      <Modal opened={deleting} onClose={() => setDeleting(false)} title="Delete host">
        <Stack>
          <Text>
            Delete <b>{h.label}</b>? Its stored credential is removed and it is no longer visited. Its metric history
            ages out with the retention period.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button color="red" onClick={() => void remove()}>
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

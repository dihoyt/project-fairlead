import { Alert, Anchor, Card, Group, Loader, Stack, Table, Text, Title, Tooltip } from "@mantine/core";
import { Link, useParams } from "react-router";
import type { PodUsage, PodView } from "@contracts/workloads";
import { Sparkline, StatusBadge, useApi } from "../../ui";
import { LogViewer } from "./LogViewer";
import { Age, Loaded, NativeLinks, OwnerLink, Trail, podPath, podStatus, spacePath, spacesPath } from "./shared";
import { EventsTable } from "./tables";
import { USAGE_POLL_MS, UsageBar } from "./usage";

const POLL_MS = 10_000;

const STATE_STATUS = { running: "ok", waiting: "warn", terminated: "unknown", unknown: "unknown" } as const;

// CPU and memory come from the node and container metrics collector; on an
// install without it the sparklines read "no data" and nothing else changes.
function Containers({ pod, usage }: { pod: PodView; usage?: PodUsage }) {
  return (
    <Table.ScrollContainer minWidth={usage ? 1180 : 820}>
      <Table verticalSpacing="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Container</Table.Th>
            <Table.Th>State</Table.Th>
            <Table.Th>Restarts</Table.Th>
            {usage ? (
              <>
                <Table.Th>CPU</Table.Th>
                <Table.Th>Memory</Table.Th>
              </>
            ) : null}
            <Table.Th>CPU (1h)</Table.Th>
            <Table.Th>Memory (1h)</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {pod.containers.map((c) => {
            const labels = { namespace: pod.namespace, pod: pod.name, container: c.name };
            const u = usage?.containers.find((x) => x.name === c.name);
            const status =
              c.state === "waiting" && c.reason === "CrashLoopBackOff"
                ? "crit"
                : c.state === "terminated" && c.reason === "Completed"
                  ? "ok"
                  : c.state === "running" && !c.ready
                    ? "warn"
                    : STATE_STATUS[c.state];
            return (
              <Table.Tr key={c.name}>
                <Table.Td>
                  <Text size="sm" fw={500}>
                    {c.name}
                  </Text>
                  <Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: "break-all" }}>
                    {c.image}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <StatusBadge
                    status={status}
                    label={c.reason ?? (c.state === "running" && !c.ready ? "running, not ready" : c.state)}
                  />
                </Table.Td>
                <Table.Td>
                  <Text size="sm" ff="monospace" c={c.restarts > 0 ? "yellow" : undefined}>
                    {c.restarts}
                  </Text>
                </Table.Td>
                {usage ? (
                  <>
                    <Table.Td>
                      <UsageBar resource="cpu" usage={u?.cpu} />
                    </Table.Td>
                    <Table.Td>
                      <UsageBar resource="memory" usage={u?.memory} />
                    </Table.Td>
                  </>
                ) : null}
                <Table.Td>
                  <Sparkline query={{ series: "container.cpu.percent", labels }} range="1h" unit="percent" />
                </Table.Td>
                <Table.Td>
                  <Sparkline query={{ series: "container.memory.bytes", labels }} range="1h" unit="bytes" />
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

// The pod's details, logs and events; on its own page and in the drawer a
// space opens pods in. usage: the pod's entry in its space's usage report.
export function PodDetail({
  namespace,
  name,
  usage,
  inDrawer = false,
}: {
  namespace: string;
  name: string;
  usage?: PodUsage;
  inDrawer?: boolean;
}) {
  const params = { namespace, pod: name };
  const pod = useApi("GET /api/workloads/namespaces/:namespace/pods/:pod", { params }, { pollMs: POLL_MS });
  const events = useApi(
    "GET /api/workloads/namespaces/:namespace/events",
    { params: { namespace }, query: { object: `Pod/${name}` } },
    { pollMs: POLL_MS }
  );
  const data = pod.data;
  const state = data ? podStatus(data) : null;

  return (
    <Stack gap="md">
      <Group gap="sm">
        <Title order={inDrawer ? 3 : 2} style={{ wordBreak: "break-all" }}>
          {name}
        </Title>
        {state ? <StatusBadge status={state.status} label={state.label} /> : null}
      </Group>
      <Group gap="md">
        {inDrawer ? (
          <Anchor component={Link} to={podPath(namespace, name)} size="sm">
            Open pod page
          </Anchor>
        ) : null}
        <NativeLinks kind="Pod" namespace={namespace} name={name} />
      </Group>
      {pod.error ? <Alert color={data ? "yellow" : "red"}>{pod.error}</Alert> : null}
      {pod.loading && !data ? <Loader size="sm" /> : null}
      {data ? (
        <>
          <Card withBorder padding="md">
            <Group gap="xl" wrap="wrap">
              <Stack gap={2}>
                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                  Owner
                </Text>
                <OwnerLink namespace={namespace} owner={data.owner} />
              </Stack>
              <Stack gap={2}>
                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                  Node
                </Text>
                <Text size="sm">{data.node ?? "not scheduled"}</Text>
              </Stack>
              <Stack gap={2}>
                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                  Ready
                </Text>
                <Text size="sm" ff="monospace">
                  {data.ready}
                </Text>
              </Stack>
              <Stack gap={2}>
                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                  Restarts
                </Text>
                <Tooltip label="Across all containers">
                  <Text size="sm" ff="monospace">
                    {data.restarts}
                  </Text>
                </Tooltip>
              </Stack>
              <Stack gap={2}>
                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                  Created
                </Text>
                <Age at={data.createdAt} />
              </Stack>
            </Group>
          </Card>
          <Containers pod={data} usage={usage} />
          <Title order={4}>Logs</Title>
          <LogViewer key={`${data.namespace}/${data.name}`} pod={data} />
        </>
      ) : null}
      <Title order={4}>Events</Title>
      <Loaded {...events} empty="No recent events for this pod.">
        {(items) => <EventsTable namespace={namespace} items={items} />}
      </Loaded>
    </Stack>
  );
}

export function PodPage() {
  const { namespace = "", pod: name = "" } = useParams();
  const usage = useApi(
    "GET /api/workloads/namespaces/:namespace/usage",
    { params: { namespace } },
    { pollMs: USAGE_POLL_MS }
  );
  return (
    <Stack gap="md">
      <Trail
        items={[
          { label: "Workloads", to: spacesPath },
          { label: namespace, to: spacePath(namespace, "pods") },
          { label: name },
        ]}
      />
      <PodDetail namespace={namespace} name={name} usage={usage.data?.pods.find((p) => p.name === name)} />
    </Stack>
  );
}

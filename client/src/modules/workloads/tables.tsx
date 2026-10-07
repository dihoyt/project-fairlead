import { Anchor, Badge, Group, Table, Text, Tooltip } from "@mantine/core";
import { Link } from "react-router";
import type { EventView, PodView, WorkloadView } from "@contracts/workloads";
import { StatusBadge } from "../../ui";
import { Age, ManagedBadge, OwnerLink, podPath, podStatus, splitRef, workloadPath, workloadStatus } from "./shared";

export function WorkloadsTable({ items }: { items: WorkloadView[] }) {
  return (
    <Table.ScrollContainer minWidth={760}>
      <Table verticalSpacing="xs" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Name</Table.Th>
            <Table.Th>Kind</Table.Th>
            <Table.Th>State</Table.Th>
            <Table.Th>Ready</Table.Th>
            <Table.Th>Images</Table.Th>
            <Table.Th>Age</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {items.map((w) => {
            const state = workloadStatus(w);
            return (
              <Table.Tr key={`${w.kind}/${w.name}`}>
                <Table.Td>
                  <Group gap="xs" wrap="nowrap">
                    <Anchor component={Link} to={workloadPath(w.namespace, w.kind, w.name)} size="sm" fw={500}>
                      {w.name}
                    </Anchor>
                    <ManagedBadge by={w.managedBy} />
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{w.kind}</Text>
                </Table.Td>
                <Table.Td>
                  <StatusBadge status={state.status} label={state.label} />
                </Table.Td>
                <Table.Td>
                  <Text size="sm" ff="monospace">
                    {w.ready}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" ff="monospace" c="dimmed" lineClamp={2}>
                    {w.images.join(", ")}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Age at={w.createdAt} />
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

export function PodsTable({ items, showOwner = true }: { items: PodView[]; showOwner?: boolean }) {
  return (
    <Table.ScrollContainer minWidth={760}>
      <Table verticalSpacing="xs" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Pod</Table.Th>
            <Table.Th>State</Table.Th>
            <Table.Th>Ready</Table.Th>
            <Table.Th>Restarts</Table.Th>
            <Table.Th>Node</Table.Th>
            {showOwner ? <Table.Th>Owner</Table.Th> : null}
            <Table.Th>Age</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {items.map((pod) => {
            const state = podStatus(pod);
            return (
              <Table.Tr key={pod.name}>
                <Table.Td>
                  <Anchor component={Link} to={podPath(pod.namespace, pod.name)} size="sm" fw={500}>
                    {pod.name}
                  </Anchor>
                </Table.Td>
                <Table.Td>
                  <StatusBadge status={state.status} label={state.label} />
                </Table.Td>
                <Table.Td>
                  <Text size="sm" ff="monospace">
                    {pod.ready}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" ff="monospace" c={pod.restarts > 0 ? "yellow" : undefined}>
                    {pod.restarts}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{pod.node ?? "—"}</Text>
                </Table.Td>
                {showOwner ? (
                  <Table.Td>
                    <OwnerLink namespace={pod.namespace} owner={pod.owner} />
                  </Table.Td>
                ) : null}
                <Table.Td>
                  <Age at={pod.createdAt} />
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function EventObject({ namespace, object }: { namespace: string; object: string }) {
  const { kind, name } = splitRef(object);
  if (kind === "Pod") {
    return (
      <Anchor component={Link} to={podPath(namespace, name)} size="sm">
        {object}
      </Anchor>
    );
  }
  return <OwnerLink namespace={namespace} owner={object} />;
}

export function EventsTable({ namespace, items }: { namespace: string; items: EventView[] }) {
  return (
    <Table.ScrollContainer minWidth={760}>
      <Table verticalSpacing="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th style={{ whiteSpace: "nowrap" }}>Last seen</Table.Th>
            <Table.Th w={100}>Type</Table.Th>
            <Table.Th>Reason</Table.Th>
            <Table.Th>Object</Table.Th>
            <Table.Th>Message</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {items.map((e, i) => (
            <Table.Tr key={`${e.object}/${e.reason}/${e.lastSeen}/${i}`}>
              <Table.Td style={{ whiteSpace: "nowrap" }}>
                <Age at={e.lastSeen} />
              </Table.Td>
              <Table.Td>
                <Badge
                  size="sm"
                  radius="xs"
                  variant="light"
                  color={e.type === "Warning" ? "yellow" : "gray"}
                  style={{ overflow: "visible" }}
                >
                  {e.type}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Group gap={4} wrap="nowrap">
                  <Text size="sm">{e.reason}</Text>
                  {e.count > 1 ? (
                    <Tooltip label={`Seen ${e.count} times`}>
                      <Text size="xs" c="dimmed">
                        ×{e.count}
                      </Text>
                    </Tooltip>
                  ) : null}
                </Group>
              </Table.Td>
              <Table.Td>
                <EventObject namespace={namespace} object={e.object} />
              </Table.Td>
              <Table.Td>
                <Text size="sm" style={{ wordBreak: "break-word" }}>
                  {e.message}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

import { useState } from "react";
import { Anchor, Group, Stack, Switch, Table, Text, TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { Link } from "react-router";
import type { NamespaceUsage, NamespaceView } from "@contracts/workloads";
import { PageHeader } from "../../shell/PageHeader";
import { StatusBadge, useApi } from "../../ui";
import { Age, Loaded, ManagedBadge, spacePath } from "./shared";
import {
  MiniSpark,
  NotCollected,
  RangePicker,
  SortHeader,
  USAGE_POLL_MS,
  UsageBar,
  compareMaybe,
  shownValue,
  useUsageRange,
  type Sort,
} from "./usage";

const POLL_MS = 15_000;

// Rancher's own: a cluster ("c-xxxxx" and the "local" cluster), its projects
// ("c-xxxxx-p-xxxxx", "p-xxxxx"), users ("user-xxxxx") and Fleet's
// workspaces and per-cluster namespaces. Rancher ids are five characters.
const RANCHER_SPACE =
  /^(?:c-[a-z0-9]{5}(?:-p-[a-z0-9]{5})?|p-[a-z0-9]{5}|user-[a-z0-9]{5}|cluster-fleet-.+|fleet-(?:default|local)|local)$/;

// Spaces the platform itself runs in; hidden until asked for, so a newcomer
// sees their own apps first.
export function isSystemSpace(name: string): boolean {
  return name.startsWith("kube-") || name.endsWith("-system") || name.startsWith("cattle-") || RANCHER_SPACE.test(name);
}

function health(space: NamespaceView) {
  if (space.status !== "Active") return <StatusBadge status="unknown" label={space.status} />;
  if (space.unhealthyPods > 0) {
    return <StatusBadge status="crit" label={`${space.unhealthyPods} unhealthy`} />;
  }
  return <StatusBadge status="ok" label="Healthy" />;
}

type Column = "name" | "pods" | "cpu" | "memory";

// Unsorted: problems first, then by name.
const byDefault = (a: NamespaceView, b: NamespaceView) =>
  Number(b.unhealthyPods > 0) - Number(a.unhealthyPods > 0) || a.name.localeCompare(b.name);

export function sortSpaces(
  spaces: NamespaceView[],
  usage: Map<string, NamespaceUsage>,
  sort: Sort<Column> | null
): NamespaceView[] {
  if (!sort) return spaces.toSorted(byDefault);
  return spaces.toSorted((a, b) => {
    switch (sort.key) {
      case "name":
        return sort.dir === "asc" ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      case "pods":
        return compareMaybe(a.pods, b.pods, sort.dir) || a.name.localeCompare(b.name);
      default: {
        const value = (s: NamespaceView) => shownValue(usage.get(s.name)?.[sort.key as "cpu" | "memory"]);
        return compareMaybe(value(a), value(b), sort.dir) || a.name.localeCompare(b.name);
      }
    }
  });
}

export function SpacesPage() {
  const { data, error, loading } = useApi("GET /api/workloads/namespaces", undefined, { pollMs: POLL_MS });
  const [range, setRange] = useUsageRange();
  const usage = useApi("GET /api/workloads/usage", { query: { range } }, { pollMs: USAGE_POLL_MS });
  const [filter, setFilter] = useState("");
  const [system, setSystem] = useState(false);
  const [sort, setSort] = useState<Sort<Column> | null>(null);
  const byName = new Map((usage.data?.namespaces ?? []).map((u) => [u.namespace, u]));

  const shown = data
    ? sortSpaces(
        data.filter((s) => (system || !isSystemSpace(s.name)) && s.name.includes(filter.trim().toLowerCase())),
        byName,
        sort
      )
    : null;
  const header = (label: string, column: Column, numeric = true) => (
    <SortHeader label={label} column={column} sort={sort} onSort={setSort} numeric={numeric} />
  );

  return (
    <Stack gap="md">
      <PageHeader
        title="Workloads"
        description="Every space in the cluster, what runs in it and what it uses. Read-only."
        actions={
          <Group gap="md">
            <RangePicker value={range} onChange={setRange} />
            <TextInput
              size="xs"
              placeholder="Filter spaces"
              leftSection={<IconSearch size={14} />}
              value={filter}
              onChange={(e) => setFilter(e.currentTarget.value)}
            />
            <Switch
              size="xs"
              label="System spaces"
              checked={system}
              onChange={(e) => setSystem(e.currentTarget.checked)}
            />
          </Group>
        }
      />
      <NotCollected collected={usage.data?.collected} />
      <Loaded data={shown} error={error} loading={loading} empty="No spaces match.">
        {(items) => (
          <Table.ScrollContainer minWidth={980}>
            <Table verticalSpacing="xs" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  {header("Space", "name", false)}
                  <Table.Th>Health</Table.Th>
                  <Table.Th>Workloads</Table.Th>
                  {header("Pods", "pods")}
                  {header("CPU", "cpu")}
                  {header("Memory", "memory")}
                  <Table.Th>CPU ({range})</Table.Th>
                  <Table.Th>Age</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {items.map((space) => (
                  <Table.Tr key={space.name}>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <Anchor component={Link} to={spacePath(space.name)} size="sm" fw={500}>
                          {space.name}
                        </Anchor>
                        <ManagedBadge by={space.managedBy} />
                      </Group>
                    </Table.Td>
                    <Table.Td>{health(space)}</Table.Td>
                    <Table.Td>
                      <Text size="sm">{space.workloads}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{space.pods}</Text>
                    </Table.Td>
                    <Table.Td>
                      <UsageBar resource="cpu" usage={byName.get(space.name)?.cpu} />
                    </Table.Td>
                    <Table.Td>
                      <UsageBar resource="memory" usage={byName.get(space.name)?.memory} />
                    </Table.Td>
                    <Table.Td>
                      <MiniSpark points={byName.get(space.name)?.cpuPoints} />
                    </Table.Td>
                    <Table.Td>
                      <Age at={space.createdAt} />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Loaded>
    </Stack>
  );
}

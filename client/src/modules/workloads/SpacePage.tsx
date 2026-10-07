import { Badge, Group, Stack, Tabs, Title } from "@mantine/core";
import { useParams, useSearchParams } from "react-router";
import { useApi } from "../../ui";
import { Loaded, NativeLinks, Trail, podStatus, spacesPath } from "./shared";
import { EventsTable, PodsTable, WorkloadsTable } from "./tables";

const POLL_MS = 10_000;
const TABS = ["workloads", "pods", "events"] as const;
type Tab = (typeof TABS)[number];

export function SpacePage() {
  const namespace = useParams().namespace ?? "";
  const [search, setSearch] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(search.get("tab") ?? "")
    ? (search.get("tab") as Tab)
    : "workloads";
  const params = { namespace };

  const workloads = useApi(
    "GET /api/workloads/namespaces/:namespace/workloads",
    { params },
    { pollMs: POLL_MS, enabled: tab === "workloads" }
  );
  // Fetched on every tab for the unhealthy count on the Pods tab.
  const pods = useApi("GET /api/workloads/namespaces/:namespace/pods", { params }, { pollMs: POLL_MS });
  const events = useApi(
    "GET /api/workloads/namespaces/:namespace/events",
    { params },
    { pollMs: POLL_MS, enabled: tab === "events" }
  );
  const unhealthy = pods.data?.filter((p) => podStatus(p).status !== "ok").length ?? 0;

  return (
    <Stack gap="md">
      <Trail items={[{ label: "Workloads", to: spacesPath }, { label: namespace }]} />
      <Group justify="space-between" align="flex-end">
        <Title order={2}>{namespace}</Title>
        <NativeLinks kind="Namespace" namespace={namespace} name={namespace} />
      </Group>
      <Tabs
        value={tab}
        onChange={(value) => setSearch(value && value !== "workloads" ? { tab: value } : {}, { replace: true })}
        keepMounted={false}
      >
        <Tabs.List>
          <Tabs.Tab value="workloads">Workloads</Tabs.Tab>
          <Tabs.Tab
            value="pods"
            rightSection={
              unhealthy > 0 ? (
                <Badge size="xs" color="red" radius="xs">
                  {unhealthy}
                </Badge>
              ) : null
            }
          >
            Pods
          </Tabs.Tab>
          <Tabs.Tab value="events">Events</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="workloads" pt="md">
          <Loaded {...workloads} empty="Nothing is deployed in this space.">
            {(items) => <WorkloadsTable items={items} />}
          </Loaded>
        </Tabs.Panel>
        <Tabs.Panel value="pods" pt="md">
          <Loaded {...pods} empty="No pods in this space.">
            {(items) => <PodsTable items={items} />}
          </Loaded>
        </Tabs.Panel>
        <Tabs.Panel value="events" pt="md">
          <Loaded {...events} empty="No recent events. The cluster keeps them for about an hour.">
            {(items) => <EventsTable namespace={namespace} items={items} />}
          </Loaded>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

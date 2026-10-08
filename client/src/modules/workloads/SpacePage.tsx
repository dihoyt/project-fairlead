import { Badge, Drawer, Group, Stack, Tabs, Title } from "@mantine/core";
import { useParams, useSearchParams } from "react-router";
import { useApi } from "../../ui";
import { Loaded, NativeLinks, Trail, podStatus, spacesPath } from "./shared";
import { PodDetail } from "./PodPage";
import { EventsTable, PodsTable, WorkloadsTable } from "./tables";
import { NotCollected, RangePicker, USAGE_POLL_MS, useUsageRange } from "./usage";

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
  const [range, setRange] = useUsageRange();
  const usage = useApi(
    "GET /api/workloads/namespaces/:namespace/usage",
    { params, query: { range } },
    { pollMs: USAGE_POLL_MS, enabled: tab !== "events" }
  );
  const workloadUsage = new Map((usage.data?.workloads ?? []).map((w) => [`${w.kind}/${w.name}`, w]));
  const podUsage = new Map((usage.data?.pods ?? []).map((p) => [p.name, p]));
  // The open pod is in the URL, so the drawer survives a reload and a link.
  const openPod = search.get("pod");
  const setOpenPod = (name: string | null) =>
    setSearch(
      (prev) => {
        const out = new URLSearchParams(prev);
        if (name) out.set("pod", name);
        else out.delete("pod");
        return out;
      },
      { replace: !name }
    );

  return (
    <Stack gap="md">
      <Trail items={[{ label: "Workloads", to: spacesPath }, { label: namespace }]} />
      <Group justify="space-between" align="flex-end">
        <Title order={2}>{namespace}</Title>
        <Group gap="md">
          <NativeLinks kind="Namespace" namespace={namespace} name={namespace} />
          <RangePicker value={range} onChange={setRange} />
        </Group>
      </Group>
      <NotCollected collected={usage.data?.collected} />
      <Tabs
        value={tab}
        onChange={(value) =>
          setSearch(
            (prev) => {
              const out = new URLSearchParams(prev);
              if (value && value !== "workloads") out.set("tab", value);
              else out.delete("tab");
              return out;
            },
            { replace: true }
          )
        }
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
            {(items) => <WorkloadsTable items={items} usage={workloadUsage} />}
          </Loaded>
        </Tabs.Panel>
        <Tabs.Panel value="pods" pt="md">
          <Loaded {...pods} empty="No pods in this space.">
            {(items) => <PodsTable items={items} usage={podUsage} onOpen={(pod) => setOpenPod(pod.name)} />}
          </Loaded>
        </Tabs.Panel>
        <Tabs.Panel value="events" pt="md">
          <Loaded {...events} empty="No recent events. The cluster keeps them for about an hour.">
            {(items) => <EventsTable namespace={namespace} items={items} />}
          </Loaded>
        </Tabs.Panel>
      </Tabs>
      <Drawer
        opened={openPod !== null}
        onClose={() => setOpenPod(null)}
        position="right"
        size="min(1200px, 92vw)"
        title="Pod"
      >
        {openPod ? <PodDetail namespace={namespace} name={openPod} usage={podUsage.get(openPod)} inDrawer /> : null}
      </Drawer>
    </Stack>
  );
}

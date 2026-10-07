import { Alert, Card, Group, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useParams } from "react-router";
import { StatusBadge, useApi } from "../../ui";
import {
  Age,
  Loaded,
  ManagedBadge,
  NativeLinks,
  Trail,
  isWorkloadKind,
  spacePath,
  spacesPath,
  workloadStatus,
} from "./shared";
import { EventsTable, PodsTable } from "./tables";

const POLL_MS = 10_000;

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      {children}
    </Stack>
  );
}

export function WorkloadPage() {
  const { namespace = "", kind = "", name = "" } = useParams();
  const ref = `${kind}/${name}`;
  const params = { namespace };
  const known = isWorkloadKind(kind);

  const workloads = useApi(
    "GET /api/workloads/namespaces/:namespace/workloads",
    { params },
    { pollMs: POLL_MS, enabled: known }
  );
  const pods = useApi(
    "GET /api/workloads/namespaces/:namespace/pods",
    { params, query: { workload: ref } },
    { pollMs: POLL_MS, enabled: known }
  );
  const events = useApi(
    "GET /api/workloads/namespaces/:namespace/events",
    { params, query: { object: ref } },
    { pollMs: POLL_MS, enabled: known }
  );
  const workload = workloads.data?.find((w) => w.kind === kind && w.name === name);
  const state = workload ? workloadStatus(workload) : null;

  return (
    <Stack gap="md">
      <Trail
        items={[{ label: "Workloads", to: spacesPath }, { label: namespace, to: spacePath(namespace) }, { label: ref }]}
      />
      <Group gap="sm">
        <Title order={2}>{name}</Title>
        <Text c="dimmed">{kind}</Text>
        {state ? <StatusBadge status={state.status} label={state.label} /> : null}
        {workload ? <ManagedBadge by={workload.managedBy} /> : null}
      </Group>
      {known ? <NativeLinks kind={kind} namespace={namespace} name={name} /> : null}
      {!known ? <Alert color="red">{kind} is not a kind this browser shows.</Alert> : null}
      {workloads.error ? <Alert color="red">{workloads.error}</Alert> : null}
      {known && workloads.data && !workload ? (
        <Alert color="yellow">
          No {kind} named {name} in {namespace}. It may have been deleted.
        </Alert>
      ) : null}
      {workload ? (
        <Card withBorder padding="md">
          <SimpleGrid cols={{ base: 2, sm: 4 }}>
            <Fact label="Ready">
              <Text ff="monospace">{workload.ready}</Text>
            </Fact>
            <Fact label={workload.kind === "Job" ? "Succeeded" : "Available"}>
              <Text ff="monospace">
                {workload.available} of {workload.desired}
              </Text>
            </Fact>
            <Fact label="Created">
              <Age at={workload.createdAt} />
            </Fact>
            <Fact label="Images">
              {workload.images.map((image) => (
                <Text key={image} size="sm" ff="monospace" style={{ wordBreak: "break-all" }}>
                  {image}
                </Text>
              ))}
            </Fact>
          </SimpleGrid>
        </Card>
      ) : null}
      {known ? (
        <>
          <Title order={4}>Pods</Title>
          <Loaded {...pods} empty="No pods right now.">
            {(items) => <PodsTable items={items} showOwner={false} />}
          </Loaded>
          <Title order={4}>Events</Title>
          <Loaded {...events} empty="No recent events for this workload or its pods.">
            {(items) => <EventsTable namespace={namespace} items={items} />}
          </Loaded>
        </>
      ) : null}
    </Stack>
  );
}

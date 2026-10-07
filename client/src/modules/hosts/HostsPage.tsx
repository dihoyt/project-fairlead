import { useState } from "react";
import { Alert, Button, Group, Modal, SimpleGrid, Skeleton, Stack, Text, Title } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import type { HostRequest } from "@contracts/hosts";
import { Tile, apiRequest, useApi, useSession } from "../../ui";
import { HostForm } from "./HostForm";
import { hostSummary } from "./labels";

export function HostsPage() {
  const { me } = useSession();
  const hosts = useApi("GET /api/hosts", undefined, { pollMs: 15_000 });
  const [adding, setAdding] = useState(false);

  async function create(req: HostRequest) {
    await apiRequest("POST /api/hosts", { body: req });
    setAdding(false);
    hosts.reload();
  }

  return (
    <Stack>
      <Group justify="space-between">
        <div>
          <Title order={2}>Hosts</Title>
          <Text c="dimmed" size="sm">
            NAS boxes and Linux servers, visited over SSH with read-only commands.
          </Text>
        </div>
        {me.admin && (
          <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>
            Add host
          </Button>
        )}
      </Group>

      {hosts.error && (
        <Alert color="red" variant="light">
          {hosts.error}
        </Alert>
      )}

      {hosts.loading && !hosts.data && (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
          <Skeleton h={96} />
          <Skeleton h={96} />
        </SimpleGrid>
      )}

      {hosts.data?.length === 0 && (
        <Text c="dimmed">
          No hosts yet. Add a NAS or a Linux box with a read-only SSH user to see its disks, pools, temperatures and
          load.
        </Text>
      )}

      {hosts.data && hosts.data.length > 0 && (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
          {hosts.data.map((host) => (
            <Tile
              key={host.id}
              title={host.label}
              status={host.status}
              summary={hostSummary(host)}
              to={`/hosts/${encodeURIComponent(host.id)}`}
            />
          ))}
        </SimpleGrid>
      )}

      <Modal opened={adding} onClose={() => setAdding(false)} title="Add a host" size="lg">
        {adding && <HostForm onSubmit={create} onCancel={() => setAdding(false)} />}
      </Modal>
    </Stack>
  );
}

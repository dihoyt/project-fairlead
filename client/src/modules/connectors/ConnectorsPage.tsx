import { useState } from "react";
import { Alert, Anchor, Badge, Button, Checkbox, Group, Modal, Paper, Stack, Table, Text, Title } from "@mantine/core";
import type { ConnectorKindView, ConnectorView } from "@contracts/connectors";
import type { DriftState } from "@contracts/ownership";
import { CheckList } from "../../ui/CheckList";
import { StatusBadge } from "../../ui/StatusBadge";
import { apiRequest, useApi } from "../../ui/api";
import { relativeTime } from "../../ui/time";
import { PageHeader } from "../../shell/PageHeader";
import { ConnectorForm } from "./ConnectorForm";

const DRIFT: Record<DriftState, { label: string; color: string }> = {
  "in-sync": { label: "in sync", color: "teal" },
  drifted: { label: "changed outside, put back", color: "yellow" },
  missing: { label: "was missing, recreated", color: "yellow" },
  "conflict-unowned": { label: "not ours, left alone", color: "red" },
};

function Drift({ view }: { view: ConnectorView }) {
  if (!view.drift || view.drift.items.length === 0) return null;
  return (
    <Table fz="xs" verticalSpacing={4}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Object</Table.Th>
          <Table.Th>Type</Table.Th>
          <Table.Th>State</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {view.drift.items.map((item) => (
          <Table.Tr key={`${item.kind}:${item.key}`}>
            <Table.Td>{item.key}</Table.Td>
            <Table.Td>{item.kind}</Table.Td>
            <Table.Td>
              <Badge size="xs" variant="light" color={DRIFT[item.state].color}>
                {DRIFT[item.state].label}
              </Badge>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function Instance({
  view,
  kind,
  onChanged,
}: {
  view: ConnectorView;
  kind: ConnectorKindView | undefined;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [cleanup, setCleanup] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keeps = kind?.capabilities.some((c) => c !== "identity") ?? false;

  async function act(what: string, fn: () => Promise<unknown>) {
    setBusy(what);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Group justify="space-between" wrap="wrap">
          <Group gap="sm">
            <Title order={4}>{view.name}</Title>
            <Text size="sm" c="dimmed">
              {kind?.label ?? view.kind}
            </Text>
            <StatusBadge status={view.status} />
          </Group>
          <Group gap="xs">
            <Button
              size="xs"
              variant="default"
              loading={busy === "test"}
              onClick={() =>
                void act("test", () => apiRequest("POST /api/connectors/:id/test", { params: { id: view.id } }))
              }
            >
              Test
            </Button>
            {keeps ? (
              <Button
                size="xs"
                variant="default"
                loading={busy === "sync"}
                onClick={() =>
                  void act("sync", () => apiRequest("POST /api/connectors/:id/reconcile", { params: { id: view.id } }))
                }
              >
                Sync now
              </Button>
            ) : null}
            {kind ? (
              <Button size="xs" variant="default" onClick={() => setEditing(true)}>
                Edit
              </Button>
            ) : null}
            <Button size="xs" variant="subtle" color="red" onClick={() => setRemoving(true)}>
              Remove
            </Button>
          </Group>
        </Group>
        <Text size="xs" c="dimmed">
          Added by {view.createdBy} {relativeTime(view.createdAt)}
          {view.checkedAt ? `, checked ${relativeTime(view.checkedAt)}` : ""}
        </Text>
        {error ? <Alert color="red">{error}</Alert> : null}
        <CheckList results={view.checks} />
        <Drift view={view} />
        {view.kind === "cloudflare" ? (
          <Anchor href="#/admin/cloudflare" size="sm">
            Published apps, tunnel and Access
          </Anchor>
        ) : null}
      </Stack>
      {kind ? (
        <Modal opened={editing} onClose={() => setEditing(false)} title={`Edit ${view.name}`} size="lg">
          <ConnectorForm
            kind={kind}
            existing={view}
            onSaved={() => {
              setEditing(false);
              onChanged();
            }}
            onCancel={() => setEditing(false)}
          />
        </Modal>
      ) : null}
      <Modal opened={removing} onClose={() => setRemoving(false)} title={`Remove ${view.name}?`}>
        <Stack gap="sm">
          <Text size="sm">The stored credential is deleted.</Text>
          {keeps ? (
            <Checkbox
              checked={cleanup}
              onChange={(e) => setCleanup(e.currentTarget.checked)}
              label={`Also delete what this install created in ${kind?.label ?? view.kind}`}
            />
          ) : null}
          <Group>
            <Button
              color="red"
              loading={busy === "remove"}
              onClick={() =>
                void act("remove", async () => {
                  const result = await apiRequest("DELETE /api/connectors/:id", {
                    params: { id: view.id },
                    query: cleanup && keeps ? { cleanup: "1" } : {},
                  });
                  if (result.errors.length > 0) throw new Error(`Removed, but: ${result.errors.join("; ")}`);
                })
              }
            >
              Remove
            </Button>
            <Button variant="subtle" onClick={() => setRemoving(false)}>
              Cancel
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  );
}

export function ConnectorsPage() {
  const kinds = useApi("GET /api/connectors/kinds");
  const list = useApi("GET /api/connectors");
  const [adding, setAdding] = useState<string | null>(null);
  const kindList = kinds.data ?? [];
  const instances = list.data ?? [];
  const addable = kindList.filter((k) => !k.single || !instances.some((i) => i.kind === k.kind));
  const chosen = kindList.find((k) => k.kind === adding);

  return (
    <>
      <PageHeader
        title="Connectors"
        description="Give this install an API credential for a tool you use, and it manages that tool for you: DNS records, tunnel routes, sign-in apps. Everything it creates is marked as its own; anything else is left alone."
      />
      <Stack gap="md">
        {kinds.error || list.error ? <Alert color="red">{kinds.error ?? list.error}</Alert> : null}
        {instances.map((view) => (
          <Instance
            key={view.id}
            view={view}
            kind={kindList.find((k) => k.kind === view.kind)}
            onChanged={list.reload}
          />
        ))}
        {!list.loading && instances.length === 0 ? (
          <Text size="sm" c="dimmed">
            No connectors yet.
          </Text>
        ) : null}
        <Paper withBorder p="md">
          <Stack gap="sm">
            <Title order={4}>Add a connector</Title>
            {addable.length === 0 ? (
              <Text size="sm" c="dimmed">
                Every available connector is added.
              </Text>
            ) : (
              <Group gap="xs">
                {addable.map((k) => (
                  <Button
                    key={k.kind}
                    size="xs"
                    variant={adding === k.kind ? "filled" : "default"}
                    onClick={() => setAdding(k.kind)}
                  >
                    {k.label}
                  </Button>
                ))}
              </Group>
            )}
            {chosen ? (
              <ConnectorForm
                key={chosen.kind}
                kind={chosen}
                onSaved={() => {
                  setAdding(null);
                  list.reload();
                }}
                onCancel={() => setAdding(null)}
              />
            ) : null}
          </Stack>
        </Paper>
      </Stack>
    </>
  );
}

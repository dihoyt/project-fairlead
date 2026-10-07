import { useCallback, useEffect, useState } from "react";
import { ActionIcon, Alert, Button, Group, Modal, Stack, Table, Text, Title, Tooltip } from "@mantine/core";
import { IconPencil, IconPlus, IconSend, IconTrash } from "@tabler/icons-react";
import type { ChannelRequest, ChannelView, TestSendResult } from "@contracts/notify";
import { StatusBadge } from "../../ui";
import { notifyApi } from "./api";
import { ChannelForm } from "./ChannelForm";

const KIND_LABEL = { webhook: "Webhook", ntfy: "ntfy", discord: "Discord" } as const;

function destination(channel: ChannelView): string {
  if (channel.kind === "ntfy") return `${channel.config.server ?? "https://ntfy.sh"}/${channel.config.topic ?? ""}`;
  return channel.hasSecret ? "URL stored" : "No URL stored";
}

function ChannelState({ channel }: { channel: ChannelView }) {
  if (!channel.enabled) return <StatusBadge status="absent" label="disabled" />;
  if (channel.lastError) {
    return (
      <Tooltip label={channel.lastError} multiline maw={400}>
        <span>
          <StatusBadge status="crit" label="failing" />
        </span>
      </Tooltip>
    );
  }
  return <StatusBadge status="ok" label="enabled" />;
}

export function NotificationsPage() {
  const [channels, setChannels] = useState<ChannelView[]>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<ChannelView | "new" | null>(null);
  const [deleting, setDeleting] = useState<ChannelView | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [tested, setTested] = useState<{ channel: ChannelView; result: TestSendResult } | null>(null);

  const load = useCallback(async () => {
    try {
      setChannels(await notifyApi.list());
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(req: ChannelRequest) {
    if (editing === "new") await notifyApi.create(req);
    else if (editing) await notifyApi.update(editing.id, req);
    setEditing(null);
    await load();
  }

  async function test(channel: ChannelView) {
    setTesting(channel.id);
    try {
      setTested({ channel, result: await notifyApi.test(channel.id) });
    } catch (err) {
      setTested({ channel, result: { ok: false, error: err instanceof Error ? err.message : String(err) } });
    } finally {
      setTesting(null);
      await load();
    }
  }

  async function remove(channel: ChannelView) {
    try {
      await notifyApi.remove(channel.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setDeleting(null);
    await load();
  }

  return (
    <Stack>
      <Group justify="space-between">
        <div>
          <Title order={2}>Notifications</Title>
          <Text c="dimmed" size="sm">
            Health changes are sent once they have held for the debounce window, so a check that flaps sends once.
          </Text>
        </div>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing("new")}>
          Add channel
        </Button>
      </Group>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {tested && (
        <Alert
          color={tested.result.ok ? "teal" : "red"}
          variant="light"
          withCloseButton
          onClose={() => setTested(null)}
          title={tested.result.ok ? `Test sent to ${tested.channel.label}` : `Test to ${tested.channel.label} failed`}
        >
          {tested.result.ok ? `Accepted with HTTP ${tested.result.status ?? 200}.` : tested.result.error}
        </Alert>
      )}

      {channels && channels.length === 0 && (
        <Text c="dimmed">
          No channels yet. Add a webhook, an ntfy topic or a Discord webhook to be told when something changes.
        </Text>
      )}

      {channels && channels.length > 0 && (
        <Table.ScrollContainer minWidth={700}>
          <Table verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th>Destination</Table.Th>
                <Table.Th>Sends</Table.Th>
                <Table.Th>State</Table.Th>
                <Table.Th>Last sent</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {channels.map((channel) => (
                <Table.Tr key={channel.id}>
                  <Table.Td>{channel.label}</Table.Td>
                  <Table.Td>{KIND_LABEL[channel.kind]}</Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {destination(channel)}
                    </Text>
                  </Table.Td>
                  <Table.Td>{channel.minSeverity === "crit" ? "Critical" : "Warning and up"}</Table.Td>
                  <Table.Td>
                    <ChannelState channel={channel} />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">
                      {channel.lastSentAt ? new Date(channel.lastSentAt).toLocaleString() : "Never"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      <Tooltip label="Send a test">
                        <ActionIcon
                          variant="subtle"
                          loading={testing === channel.id}
                          onClick={() => void test(channel)}
                          aria-label="Send a test"
                        >
                          <IconSend size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Edit">
                        <ActionIcon variant="subtle" onClick={() => setEditing(channel)} aria-label="Edit">
                          <IconPencil size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Delete">
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          onClick={() => setDeleting(channel)}
                          aria-label="Delete"
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      <Modal
        opened={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Add a channel" : `Edit ${editing?.label ?? ""}`}
      >
        {editing !== null && (
          <ChannelForm
            key={editing === "new" ? "new" : editing.id}
            channel={editing === "new" ? undefined : editing}
            onSubmit={save}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>

      <Modal opened={deleting !== null} onClose={() => setDeleting(null)} title="Delete channel">
        <Stack>
          <Text>
            Delete <b>{deleting?.label}</b>? Its stored URL or token is removed and it stops receiving notifications.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button color="red" onClick={() => deleting && void remove(deleting)}>
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

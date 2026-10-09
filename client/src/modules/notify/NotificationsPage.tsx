import { useCallback, useEffect, useState } from "react";
import { ActionIcon, Alert, Button, Group, Modal, Stack, Table, Text, Title, Tooltip } from "@mantine/core";
import { useSearchParams } from "react-router";
import { IconLogin2, IconPencil, IconPlus, IconSend, IconTrash } from "@tabler/icons-react";
import type { ChannelRequest, ChannelView, TestSendResult } from "@contracts/notify";
import { StatusBadge } from "../../ui";
import { notifyApi } from "./api";
import { ChannelForm } from "./ChannelForm";

const KIND_LABEL = { webhook: "Webhook", ntfy: "ntfy", discord: "Discord", email: "Email" } as const;

const needsSignIn = (channel: ChannelView) =>
  channel.kind === "email" && channel.config.email?.mode === "oauth" && !channel.config.email.account;

function destination(channel: ChannelView): string {
  if (channel.kind === "ntfy") return `${channel.config.server ?? "https://ntfy.sh"}/${channel.config.topic ?? ""}`;
  if (channel.kind === "email") {
    const email = channel.config.email;
    if (!email) return "";
    const from = email.from || email.account;
    return `${from ? `${from} → ` : ""}${email.to.join(", ")}`;
  }
  return channel.hasSecret ? "URL stored" : "No URL stored";
}

function ChannelState({ channel }: { channel: ChannelView }) {
  if (!channel.enabled) return <StatusBadge status="absent" label="disabled" />;
  if (needsSignIn(channel)) return <StatusBadge status="warn" label="sign in" />;
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
  const [search, setSearch] = useSearchParams();
  const oauth = search.get("oauth");
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

  // Leaves the page for Google or Microsoft; the callback brings the
  // browser back here with ?oauth=ok or ?oauth=error.
  async function signIn(channel: ChannelView) {
    try {
      window.location.assign((await notifyApi.signIn(channel.id)).url);
    } catch (err) {
      setError(`Sign-in for ${channel.label} could not start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function save(req: ChannelRequest) {
    let saved: ChannelView | undefined;
    if (editing === "new") saved = await notifyApi.create(req);
    else if (editing) saved = await notifyApi.update(editing.id, req);
    setEditing(null);
    await load();
    if (saved && needsSignIn(saved)) await signIn(saved);
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

      {oauth && (
        <Alert
          color={oauth === "ok" ? "teal" : "red"}
          variant="light"
          withCloseButton
          onClose={() => setSearch({})}
          title={oauth === "ok" ? "Signed in" : "Sign-in failed"}
        >
          {oauth === "ok"
            ? `${channels?.find((c) => c.id === search.get("channel"))?.label ?? "The channel"} can now send. Send a test to check.`
            : search.get("message")}
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
          {tested.result.ok
            ? tested.channel.kind === "email"
              ? "The mail server accepted it."
              : `Accepted with HTTP ${tested.result.status ?? 200}.`
            : tested.result.error}
          {!tested.result.ok && tested.result.response && (
            <Text component="pre" size="xs" mt="xs" style={{ whiteSpace: "pre-wrap" }}>
              {tested.result.response}
            </Text>
          )}
        </Alert>
      )}

      {channels && channels.length === 0 && (
        <Text c="dimmed">
          No channels yet. Add an email address, an ntfy topic, a Discord webhook or a webhook to be told when something
          changes.
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
                      {channel.config.email?.mode === "oauth" && (
                        <Tooltip label={channel.config.email.account ? "Sign in again" : "Sign in to send"}>
                          <ActionIcon
                            variant="subtle"
                            color={channel.config.email.account ? undefined : "yellow"}
                            onClick={() => void signIn(channel)}
                            aria-label="Sign in to send"
                          >
                            <IconLogin2 size={16} />
                          </ActionIcon>
                        </Tooltip>
                      )}
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
            Delete <b>{deleting?.label}</b>? Its stored URL, token, password or sign-in is removed and it stops
            receiving notifications.
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

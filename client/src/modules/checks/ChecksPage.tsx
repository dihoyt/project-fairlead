import { useCallback, useEffect, useState } from "react";
import { ActionIcon, Alert, Badge, Button, Code, Group, Modal, Stack, Table, Text, Tooltip } from "@mantine/core";
import { IconPencil, IconPlayerPlay, IconPlus, IconTrash } from "@tabler/icons-react";
import type { CheckRequest, CheckView } from "@contracts/checks";
import { PageHeader } from "../../shell/PageHeader";
import { Sparkline, StatusBadge, relativeTime, useSession } from "../../ui";
import { checksApi } from "./api";
import { CheckForm } from "./CheckForm";

// Matches the series the checks module writes.
const LATENCY_SERIES = "check.latency.ms";

function CheckState({ check }: { check: CheckView }) {
  if (!check.enabled) return <StatusBadge status="absent" label="disabled" />;
  if (!check.last) return <StatusBadge status="unknown" label="pending" />;
  return (
    <Tooltip label={check.last.detail} multiline maw={420}>
      <span>
        <StatusBadge status={check.last.status} />
      </span>
    </Tooltip>
  );
}

export function ChecksPage() {
  const { me } = useSession();
  const canWrite = me.admin;
  const [checks, setChecks] = useState<CheckView[]>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<CheckView | "new" | null>(null);
  const [deleting, setDeleting] = useState<CheckView | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setChecks(await checksApi.list());
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  async function save(req: CheckRequest) {
    if (editing === "new") await checksApi.create(req);
    else if (editing) await checksApi.update(editing.id, req);
    setEditing(null);
    await load();
  }

  async function run(check: CheckView) {
    setRunning(check.id);
    try {
      await checksApi.run(check.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
      await load();
    }
  }

  async function remove(check: CheckView) {
    try {
      await checksApi.remove(check.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setDeleting(null);
    await load();
  }

  return (
    <Stack>
      <PageHeader
        title="HTTP checks"
        description="HTTP(S) and TCP targets probed on their own interval; results feed the Checks tile on the health board."
        actions={
          canWrite && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing("new")}>
              Add check
            </Button>
          )
        }
      />

      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(undefined)}>
          {error}
        </Alert>
      )}

      {checks && checks.length === 0 && (
        <Text c="dimmed">No checks yet. Add Grafana, Rancher or anything else with a URL or an open port.</Text>
      )}

      {checks && checks.length > 0 && (
        <Table.ScrollContainer minWidth={800}>
          <Table verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Target</Table.Th>
                <Table.Th>State</Table.Th>
                <Table.Th>Latency (ms, 1h)</Table.Th>
                <Table.Th>Last run</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {checks.map((check) => (
                <Table.Tr key={check.id}>
                  <Table.Td>
                    <Text size="sm">{check.label}</Text>
                    <Text size="xs" c="dimmed">
                      {check.last?.detail ?? `every ${Math.round(check.intervalMs / 1000)}s`}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <Badge variant="light" color="gray" size="sm">
                        {check.kind}
                      </Badge>
                      <Code>{check.target}</Code>
                    </Group>
                    <Group gap={4} mt={4}>
                      {check.insecureSkipVerify && (
                        <Tooltip label="The certificate is not verified for this check.">
                          <Badge color="orange" variant="light" size="xs">
                            unverified TLS
                          </Badge>
                        </Tooltip>
                      )}
                      {check.authHeader && (
                        <Badge color="gray" variant="outline" size="xs">
                          {check.authHeader}
                          {check.hasSecret ? "" : " (no value)"}
                        </Badge>
                      )}
                      {check.bodyMatch && (
                        <Badge color="gray" variant="outline" size="xs">
                          body match
                        </Badge>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <CheckState check={check} />
                  </Table.Td>
                  <Table.Td miw={140}>
                    <Sparkline query={{ series: LATENCY_SERIES, labels: { check: check.id } }} range="1h" />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{relativeTime(check.last?.observedAt)}</Text>
                  </Table.Td>
                  <Table.Td>
                    {canWrite && (
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        <Tooltip label="Run now">
                          <ActionIcon
                            variant="subtle"
                            loading={running === check.id}
                            onClick={() => void run(check)}
                            aria-label="Run now"
                          >
                            <IconPlayerPlay size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Edit">
                          <ActionIcon variant="subtle" onClick={() => setEditing(check)} aria-label="Edit">
                            <IconPencil size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Delete">
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            onClick={() => setDeleting(check)}
                            aria-label="Delete"
                          >
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    )}
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
        size="lg"
        title={editing === "new" ? "Add a check" : `Edit ${editing?.label ?? ""}`}
      >
        {editing !== null && (
          <CheckForm
            key={editing === "new" ? "new" : editing.id}
            check={editing === "new" ? undefined : editing}
            onSubmit={save}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>

      <Modal opened={deleting !== null} onClose={() => setDeleting(null)} title="Delete check">
        <Stack>
          <Text>
            Delete <b>{deleting?.label}</b>? Its stored header value is removed and it leaves the health board.
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

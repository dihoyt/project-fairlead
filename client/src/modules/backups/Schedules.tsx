import { useState } from "react";
import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Group,
  Modal,
  NumberInput,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import type { BackupSchedule } from "@contracts/backups";
import { apiRequest, useApi } from "../../ui";
import { DeployJobProgress } from "../../ui/deploy";

const keep = (n: number | undefined, fallback: number) => n ?? fallback;

export function scheduleText(s: BackupSchedule): string {
  const parts = [
    s.snapshotCron ? `snapshot ${s.snapshotCron}, keep ${keep(s.snapshotRetain, 24)}` : undefined,
    s.backupCron ? `backup ${s.backupCron}, keep ${keep(s.backupRetain, 14)}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("; ") : "nothing scheduled";
}

// Longhorn's RecurringJobs per group, as the console made them.
export function SchedulesCard({ canEdit, onChanged }: { canEdit: boolean; onChanged: () => void }) {
  const view = useApi("GET /api/backups/schedules");
  const [open, setOpen] = useState(false);
  const data = view.data;
  if (!data || data.longhorn === "absent") return null;
  const none = data.schedules.length === 0;
  return (
    <Card withBorder padding="sm" data-schedules={none ? "unset" : "set"}>
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
        <Stack gap={4}>
          <Text fw={600}>Schedules</Text>
          {none ? (
            <Text size="sm">
              No schedule is set from here. Suggested: every volume snapshotted hourly (24 kept) and backed up daily at
              03:00 (14 kept); volumes in the critical group backed up every 6 hours (28 kept).
            </Text>
          ) : (
            data.schedules.map((s) => (
              <Text key={s.group} size="sm">
                <Text span fw={600}>
                  {s.group}
                </Text>
                {s.group === "default" ? " (every volume in no other group)" : ""}: {scheduleText(s)}
              </Text>
            ))
          )}
          <Text size="xs" c="dimmed">
            Times are the cluster's (UTC unless set otherwise). New volumes join the default group by themselves.
          </Text>
        </Stack>
        {canEdit ? (
          <Button size="xs" variant={none ? "filled" : "default"} onClick={() => setOpen(true)}>
            {none ? "Set up schedules" : "Edit schedules"}
          </Button>
        ) : null}
      </Group>
      <Modal opened={open} onClose={() => setOpen(false)} title="Backup schedules" size="xl">
        {open ? (
          <SchedulesDialog
            initial={none ? (data.suggested ?? []) : data.schedules}
            onChanged={() => {
              view.reload();
              onChanged();
            }}
          />
        ) : null}
      </Modal>
    </Card>
  );
}

const text = (value: string) => value.trim() || undefined;

export function SchedulesDialog({ initial, onChanged }: { initial: BackupSchedule[]; onChanged: () => void }) {
  const [rows, setRows] = useState<BackupSchedule[]>(() => structuredClone(initial));
  const [job, setJob] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (job) return <DeployJobProgress jobId={job} onFinished={() => onChanged()} />;

  const update = (i: number, patch: Partial<BackupSchedule>) =>
    setRows((list) => list.map((row, n) => (n === i ? { ...row, ...patch } : row)));
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const started = await apiRequest("PUT /api/backups/schedules", { body: { schedules: rows } });
      setJob(started.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack gap="sm">
      <Table.ScrollContainer minWidth={640}>
        <Table verticalSpacing={4}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Group</Table.Th>
              <Table.Th>Snapshot cron</Table.Th>
              <Table.Th>Keep</Table.Th>
              <Table.Th>Backup cron</Table.Th>
              <Table.Th>Keep</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row, i) => (
              <Table.Tr key={i} data-group={row.group}>
                <Table.Td>
                  <TextInput
                    size="xs"
                    aria-label="Group"
                    value={row.group}
                    onChange={(e) => update(i, { group: e.currentTarget.value.trim() })}
                    disabled={initial.some((s) => s.group === row.group && row.group === "default")}
                  />
                </Table.Td>
                <Table.Td>
                  <TextInput
                    size="xs"
                    aria-label="Snapshot cron"
                    placeholder="none"
                    value={row.snapshotCron ?? ""}
                    onChange={(e) => update(i, { snapshotCron: text(e.currentTarget.value) })}
                  />
                </Table.Td>
                <Table.Td w={90}>
                  <NumberInput
                    size="xs"
                    aria-label="Snapshots kept"
                    min={1}
                    max={250}
                    value={row.snapshotRetain ?? 24}
                    onChange={(v) => update(i, { snapshotRetain: typeof v === "number" ? v : undefined })}
                  />
                </Table.Td>
                <Table.Td>
                  <TextInput
                    size="xs"
                    aria-label="Backup cron"
                    placeholder="none"
                    value={row.backupCron ?? ""}
                    onChange={(e) => update(i, { backupCron: text(e.currentTarget.value) })}
                  />
                </Table.Td>
                <Table.Td w={90}>
                  <NumberInput
                    size="xs"
                    aria-label="Backups kept"
                    min={1}
                    max={250}
                    value={row.backupRetain ?? 14}
                    onChange={(v) => update(i, { backupRetain: typeof v === "number" ? v : undefined })}
                  />
                </Table.Td>
                <Table.Td>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={`Remove ${row.group}`}
                    onClick={() => setRows((list) => list.filter((_, n) => n !== i))}
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      <Group justify="space-between">
        <Button
          size="xs"
          variant="subtle"
          leftSection={<IconPlus size={14} />}
          onClick={() => setRows((list) => [...list, { group: "", backupCron: "0 3 * * *", backupRetain: 14 }])}
        >
          Add a group
        </Button>
        <Text size="xs" c="dimmed">
          Five-field crons, such as 0 * * * * (hourly) or 0 3 * * * (03:00 daily). An empty cron turns that half off.
        </Text>
      </Group>
      {error ? <Alert color="red">{error}</Alert> : null}
      <Group justify="flex-end">
        <Button onClick={() => void save()} loading={saving} disabled={rows.some((r) => !r.group)}>
          Save schedules
        </Button>
      </Group>
    </Stack>
  );
}

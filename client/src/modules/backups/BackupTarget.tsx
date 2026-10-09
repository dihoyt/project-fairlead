import { useState } from "react";
import { Alert, Anchor, Badge, Button, Card, Group, Loader, Modal, Select, Stack, Text } from "@mantine/core";
import type { BackupTargetView } from "@contracts/backups";
import type { DeployJobView } from "@contracts/deploy";
import { apiRequest, relativeTime, useApi } from "../../ui";
import { DeployJobProgress } from "../../ui/deploy";

// Longhorn keeps snapshots on the same disks as the volume until a target
// exists, so nothing survives losing the node or the cluster.
export function BackupTargetCard({
  target,
  canEdit,
  onChanged,
}: {
  target?: BackupTargetView;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!target || target.longhorn === "absent") return null;
  const set = target.url !== "";
  const color = !set ? "orange" : target.available === false ? "red" : target.available ? "teal" : "gray";
  return (
    <Card
      withBorder
      padding="sm"
      data-backup-target={set ? (target.available === false ? "unavailable" : "set") : "unset"}
    >
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
        <Stack gap={4} maw={720}>
          <Group gap="xs">
            <Text fw={600}>Backup target</Text>
            <Badge color={color} variant="light" radius="xs">
              {!set
                ? "not set"
                : target.available === false
                  ? "unreachable"
                  : target.available
                    ? "reachable"
                    : "checking"}
            </Badge>
          </Group>
          {set ? (
            <>
              <Text size="sm">
                {target.name ? `${target.name} · ` : ""}
                <Text span ff="monospace" size="sm">
                  {target.url}
                </Text>
              </Text>
              {target.message ? (
                <Text size="sm" c="red">
                  {target.message}
                </Text>
              ) : null}
              {target.lastSyncAt ? (
                <Text size="xs" c="dimmed">
                  Longhorn last read it {relativeTime(target.lastSyncAt)}
                </Text>
              ) : null}
            </>
          ) : (
            <Text size="sm">
              Longhorn has nowhere to send backups, so every volume is only as safe as the disks it sits on. Pick an NFS
              export, S3 bucket or SMB share that every node can reach.
            </Text>
          )}
        </Stack>
        {canEdit ? (
          <Button size="xs" variant={set ? "default" : "filled"} onClick={() => setOpen(true)}>
            {set ? "Change target" : "Set backup target"}
          </Button>
        ) : null}
      </Group>
      <Modal opened={open} onClose={() => setOpen(false)} title="Backup target" size="lg">
        {open ? <TargetDialog current={target} onChanged={onChanged} /> : null}
      </Modal>
    </Card>
  );
}

const NONE = "__none__";

export function TargetDialog({ current, onChanged }: { current: BackupTargetView; onChanged: () => void }) {
  const targets = useApi("GET /api/connector-storage/targets");
  const [picked, setPicked] = useState<string | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  if (job) {
    return <DeployJobProgress jobId={job} onFinished={(_view: DeployJobView) => onChanged()} />;
  }
  const list = targets.data ?? [];
  const choice = picked ?? current.connectorId ?? list[0]?.id ?? null;
  const submit = async () => {
    setStarting(true);
    setError(null);
    try {
      const started = await apiRequest("PUT /api/backups/target", {
        body: { connectorId: choice === NONE ? null : choice },
      });
      setJob(started.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };
  return (
    <Stack gap="sm">
      {targets.loading && !targets.data ? <Loader size="sm" /> : null}
      {targets.error ? <Alert color="red">{targets.error}</Alert> : null}
      {targets.data && list.length === 0 ? (
        <Alert color="blue" variant="light" title="No storage targets yet">
          Add an NFS export, S3/MinIO bucket or SMB share under{" "}
          <Anchor href="#/admin/connectors">Admin &gt; Connectors</Anchor> first; it is checked from here before
          Longhorn uses it.
        </Alert>
      ) : null}
      {list.length > 0 ? (
        <Select
          label="Send Longhorn's backups to"
          data={[
            ...list.map((t) => ({
              value: t.id,
              label: `${t.name} (${t.protocol.toUpperCase()}, ${t.status === "ok" ? "reachable" : t.status})`,
            })),
            ...(current.url ? [{ value: NONE, label: "Nowhere (clear the target)" }] : []),
          ]}
          value={choice}
          onChange={setPicked}
          allowDeselect={false}
        />
      ) : null}
      {choice && choice !== NONE ? (
        <Text size="xs" c="dimmed">
          {list.find((t) => t.id === choice)?.url}
        </Text>
      ) : null}
      {error ? <Alert color="red">{error}</Alert> : null}
      <Group justify="flex-end">
        <Button onClick={() => void submit()} loading={starting} disabled={!choice || choice === current.connectorId}>
          {choice === NONE ? "Clear target" : "Set target"}
        </Button>
      </Group>
    </Stack>
  );
}

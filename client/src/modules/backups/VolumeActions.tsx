import { useState } from "react";
import {
  Alert,
  Button,
  Group,
  Loader,
  Menu,
  Modal,
  MultiSelect,
  Radio,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconDots } from "@tabler/icons-react";
import type { BackupSchedule, PostureRow, RestoreMode } from "@contracts/backups";
import type { DeployActionPlan } from "@contracts/deploy";
import { absoluteTime, apiRequest, formatValue, relativeTime, useApi } from "../../ui";
import { ActionPlanView, DeployJobProgress } from "../../ui/deploy";

type Open = "backup" | "groups" | "restore" | null;

const pvcName = (row: PostureRow) => `${row.pvc.namespace}/${row.pvc.name}`;

// A Longhorn volume's set-up actions; rows that aren't on Longhorn get none.
export function VolumeActions({
  row,
  schedules,
  onChanged,
}: {
  row: PostureRow;
  schedules: BackupSchedule[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<Open>(null);
  if (!row.groups || !row.pvc.uid) return null;
  const close = () => setOpen(null);
  return (
    <>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Button size="compact-xs" variant="subtle" aria-label={`Backup actions for ${pvcName(row)}`}>
            <IconDots size={14} />
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={() => setOpen("backup")}>Back up now</Menu.Item>
          <Menu.Item onClick={() => setOpen("groups")}>Backup groups…</Menu.Item>
          <Menu.Item onClick={() => setOpen("restore")}>Restore…</Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <Modal opened={open === "backup"} onClose={close} title={`Back up ${pvcName(row)} now`} size="lg">
        {open === "backup" ? <BackupNow row={row} onChanged={onChanged} /> : null}
      </Modal>
      <Modal opened={open === "groups"} onClose={close} title={`Backup groups of ${pvcName(row)}`} size="lg">
        {open === "groups" ? <Groups row={row} schedules={schedules} onChanged={onChanged} /> : null}
      </Modal>
      <Modal opened={open === "restore"} onClose={close} title={`Restore ${pvcName(row)}`} size="xl">
        {open === "restore" ? <Restore row={row} onChanged={onChanged} /> : null}
      </Modal>
    </>
  );
}

function useStart() {
  const [job, setJob] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const start = async (go: () => Promise<{ id: string }>) => {
    setStarting(true);
    setError(null);
    try {
      setJob((await go()).id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };
  return { job, error, starting, start };
}

function BackupNow({ row, onChanged }: { row: PostureRow; onChanged: () => void }) {
  const { job, error, starting, start } = useStart();
  if (job) return <DeployJobProgress jobId={job} onFinished={() => onChanged()} />;
  return (
    <Stack gap="sm">
      <Text size="sm">
        Takes a snapshot of the volume and copies it to the backup target, while the app keeps running. It is kept until
        you delete it; the schedules' retention covers only their own backups.
      </Text>
      {error ? <Alert color="red">{error}</Alert> : null}
      <Group justify="flex-end">
        <Button
          loading={starting}
          onClick={() =>
            void start(() => apiRequest("POST /api/backups/volumes/:uid/backup-now", { params: { uid: row.pvc.uid } }))
          }
        >
          Back up now
        </Button>
      </Group>
    </Stack>
  );
}

function Groups({
  row,
  schedules,
  onChanged,
}: {
  row: PostureRow;
  schedules: BackupSchedule[];
  onChanged: () => void;
}) {
  const [groups, setGroups] = useState<string[]>(row.groups ?? ["default"]);
  const { job, error, starting, start } = useStart();
  if (job) return <DeployJobProgress jobId={job} onFinished={() => onChanged()} />;
  const known = [...new Set(["default", ...schedules.map((s) => s.group), ...(row.groups ?? [])])];
  return (
    <Stack gap="sm">
      <MultiSelect
        label="Groups"
        description="A volume in no group is in default. Putting it in another group takes it out of default unless default stays ticked."
        data={known}
        value={groups}
        onChange={setGroups}
      />
      {error ? <Alert color="red">{error}</Alert> : null}
      <Group justify="flex-end">
        <Button
          loading={starting}
          onClick={() =>
            void start(() =>
              apiRequest("PUT /api/backups/volumes/:uid/groups", { params: { uid: row.pvc.uid }, body: { groups } })
            )
          }
        >
          Save
        </Button>
      </Group>
    </Stack>
  );
}

function Restore({ row, onChanged }: { row: PostureRow; onChanged: () => void }) {
  const points = useApi("GET /api/backups/volumes/:uid/backups", { params: { uid: row.pvc.uid } });
  const [backupId, setBackupId] = useState<string | null>(null);
  const [mode, setMode] = useState<RestoreMode>("new-pvc");
  const [newClaim, setNewClaim] = useState("");
  const [plan, setPlan] = useState<DeployActionPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const { job, error, starting, start } = useStart();
  const [planError, setPlanError] = useState<string | null>(null);
  if (job) return <DeployJobProgress jobId={job} onFinished={() => onChanged()} />;

  const body = () => ({
    uid: row.pvc.uid,
    backupId: backupId!,
    mode,
    ...(mode === "new-pvc" && newClaim.trim() ? { newClaim: newClaim.trim() } : {}),
  });
  const preview = async () => {
    setPlanning(true);
    setPlanError(null);
    try {
      setPlan(await apiRequest("POST /api/backups/restore/plan", { body: body() }));
    } catch (err) {
      setPlanError((err as Error).message);
    } finally {
      setPlanning(false);
    }
  };
  const completed = (points.data ?? []).filter((p) => p.state === "completed");

  return (
    <Stack gap="sm">
      {points.loading && !points.data ? <Loader size="sm" /> : null}
      {points.error ? <Alert color="red">{points.error}</Alert> : null}
      {points.data && completed.length === 0 ? (
        <Alert color="yellow" variant="light">
          This volume has no completed backup on the target yet.
        </Alert>
      ) : null}
      {completed.length > 0 ? (
        <Radio.Group
          label="Restore point"
          value={backupId}
          onChange={(v) => {
            setBackupId(v);
            setPlan(null);
          }}
        >
          <Stack gap={6} mt={6}>
            {completed.slice(0, 30).map((p) => (
              <Radio
                key={p.id}
                value={p.id}
                label={`${relativeTime(p.at)} · ${absoluteTime(p.at)}${p.sizeBytes ? ` · ${formatValue(p.sizeBytes, "bytes")}` : ""} · ${p.createdBy ?? "manual"}`}
              />
            ))}
          </Stack>
        </Radio.Group>
      ) : null}
      <SegmentedControl
        value={mode}
        onChange={(v) => {
          setMode(v as RestoreMode);
          setPlan(null);
        }}
        data={[
          { label: "To a new claim (safe)", value: "new-pvc" },
          { label: "In place (stops the app)", value: "in-place" },
        ]}
      />
      {mode === "new-pvc" ? (
        <TextInput
          label="New claim's name"
          placeholder={`${row.pvc.name}-restored-yyyymmdd`}
          value={newClaim}
          onChange={(e) => {
            setNewClaim(e.currentTarget.value);
            setPlan(null);
          }}
        />
      ) : null}
      {planError ? <Alert color="red">{planError}</Alert> : null}
      {plan ? <ActionPlanView plan={plan} /> : null}
      {error ? <Alert color="red">{error}</Alert> : null}
      <Group justify="flex-end">
        <Button variant="default" onClick={() => void preview()} loading={planning} disabled={!backupId}>
          Preview
        </Button>
        <Button
          color={mode === "in-place" ? "orange" : undefined}
          disabled={!plan?.allowed}
          loading={starting}
          onClick={() => void start(() => apiRequest("POST /api/backups/restore", { body: body() }))}
        >
          {mode === "in-place" ? "Restore in place" : "Restore"}
        </Button>
      </Group>
    </Stack>
  );
}

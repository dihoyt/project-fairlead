import { useState } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import type { Me } from "@contracts/auth";
import type { DeployActionPlan } from "@contracts/deploy";
import { formatBytes } from "@contracts/disk";
import type { PostgresBackupView, PostgresClusterView, PostgresState } from "@contracts/postgres";
import { StatusBadge, absoluteTime, apiRequest, relativeTime, useApi } from "../../ui";
import { ActionPlanView, DeployJobProgress } from "../../ui/deploy";

const STATE_COLOR: Record<PostgresState, string> = {
  ready: "teal",
  starting: "blue",
  degraded: "orange",
  unknown: "gray",
  absent: "gray",
};
const DEFAULT_SCHEDULE = "0 2 * * *";
const DEFAULT_RETENTION = 14;
const OFF = "__off__";
const SHOWN_POINTS = 5;

// The shared Postgres: its cluster and databases, where its backups go,
// and a restore into a new cluster. Shown once the cluster exists.
export function PostgresCard({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const cluster = useApi("GET /api/postgres/cluster");
  const databases = useApi("GET /api/postgres/databases");
  const backups = useApi("GET /api/postgres/backups");
  const [dialog, setDialog] = useState<"backups" | "restore" | { remove: string } | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const c = cluster.data;
  if (!c || c.state === "absent" || !c.name) return null;
  const b = backups.data;

  const reload = () => {
    cluster.reload();
    databases.reload();
    backups.reload();
    onChanged();
  };
  const backupNow = async () => {
    setBusy(true);
    setError(null);
    try {
      setJob((await apiRequest("POST /api/postgres/backups/now")).id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const started = (id: string) => {
    setDialog(null);
    setJob(id);
  };

  return (
    <Card withBorder padding="sm" data-postgres={b?.method ?? "loading"}>
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
          <Stack gap={4}>
            <Group gap="xs">
              <Text fw={600}>Shared Postgres</Text>
              <Badge color={STATE_COLOR[c.state]} variant="light" radius="xs">
                {c.state}
              </Badge>
            </Group>
            <ClusterLine view={c} />
            {databases.data && databases.data.length > 0 ? (
              <Text size="sm">
                Databases:{" "}
                {databases.data
                  .map((db) => `${db.database}${db.sizeBytes !== undefined ? ` (${formatBytes(db.sizeBytes)})` : ""}`)
                  .join(", ")}
              </Text>
            ) : null}
          </Stack>
          {me.admin ? (
            <Group gap="xs">
              <Button
                size="xs"
                variant={b?.method === "none" ? "filled" : "default"}
                onClick={() => setDialog("backups")}
              >
                {b?.method === "none" ? "Set up backups" : "Change backups"}
              </Button>
              <Button
                size="xs"
                variant="default"
                loading={busy}
                disabled={!b || b.method === "none"}
                onClick={() => void backupNow()}
              >
                Back up now
              </Button>
              <Button
                size="xs"
                variant="default"
                disabled={!b || b.method === "none" || b.restorePoints.every((p) => p.state !== "completed")}
                onClick={() => setDialog("restore")}
              >
                Restore…
              </Button>
            </Group>
          ) : null}
        </Group>
        {b ? <BackupLines view={b} /> : backups.loading ? <Loader size="xs" /> : null}
        {c.previous.length > 0 ? (
          <Stack gap={2}>
            {c.previous.map((p) => (
              <Group key={p.name} gap="xs">
                <Text size="sm">
                  {p.name} was replaced by a restore{p.hibernated ? " and is stopped" : ""}; its volumes are kept.
                </Text>
                {me.admin ? (
                  <Anchor size="sm" c="red" onClick={() => setDialog({ remove: p.name })}>
                    Delete it
                  </Anchor>
                ) : null}
              </Group>
            ))}
          </Stack>
        ) : null}
        {error ? <Alert color="red">{error}</Alert> : null}
        {job ? <DeployJobProgress jobId={job} onFinished={reload} /> : null}
      </Stack>
      <Modal opened={dialog === "backups"} onClose={() => setDialog(null)} title="Postgres backups" size="lg">
        {dialog === "backups" && b ? <BackupsDialog current={b} onStarted={started} /> : null}
      </Modal>
      <Modal opened={dialog === "restore"} onClose={() => setDialog(null)} title="Restore Postgres" size="lg">
        {dialog === "restore" && b ? <RestoreDialog current={b} cluster={c.name} onStarted={started} /> : null}
      </Modal>
      <Modal
        opened={typeof dialog === "object" && dialog !== null}
        onClose={() => setDialog(null)}
        title="Delete a replaced cluster"
        size="lg"
      >
        {typeof dialog === "object" && dialog !== null ? (
          <RemoveDialog name={dialog.remove} onStarted={started} />
        ) : null}
      </Modal>
    </Card>
  );
}

function ClusterLine({ view }: { view: PostgresClusterView }) {
  return (
    <Text size="sm">
      {view.name}: {view.readyInstances}/{view.instances} instances ready
      {view.version ? `, Postgres ${view.version}` : ""}
      {view.size ? `, ${view.size} each` : ""}
      {view.state !== "ready" && view.phase ? ` (${view.phase})` : ""}.
    </Text>
  );
}

function BackupLines({ view }: { view: PostgresBackupView }) {
  const points = view.restorePoints.slice(0, SHOWN_POINTS);
  return (
    <Stack gap={4}>
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <StatusBadge status={view.status} />
        <Text size="sm">{view.detail}</Text>
      </Group>
      <Text size="sm" c="dimmed">
        {view.reason}
      </Text>
      {view.method === "pitr" && view.firstRecoverabilityPoint ? (
        <Text size="sm">Restore to any moment since {absoluteTime(view.firstRecoverabilityPoint)}.</Text>
      ) : null}
      {view.schedule ? (
        <Text size="xs" c="dimmed">
          {view.method === "pitr" ? "Base backups" : "Dumps"} on {view.schedule} (UTC)
          {view.retention ? `, ${view.retention}${view.method === "pitr" ? " days" : ""} kept` : ""}
          {view.destination ? ` · ${view.destination}` : ""}
        </Text>
      ) : null}
      {points.length > 0 ? (
        <Stack gap={0}>
          {points.map((p) => (
            <Text key={p.id} size="xs" c={p.state === "failed" ? "red" : undefined}>
              {p.kind === "dump" ? "Dump" : "Base backup"} {relativeTime(p.at)}
              {p.state !== "completed" ? ` (${p.state}${p.message ? `: ${p.message}` : ""})` : ""}
            </Text>
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
}

function BackupsDialog({ current, onStarted }: { current: PostgresBackupView; onStarted: (id: string) => void }) {
  const targets = useApi("GET /api/connector-storage/targets");
  const [picked, setPicked] = useState<string | null>(null);
  const [schedule, setSchedule] = useState(current.schedule ?? DEFAULT_SCHEDULE);
  const [retention, setRetention] = useState<number>(current.retention ?? DEFAULT_RETENTION);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const list = targets.data ?? [];
  const choice = picked ?? current.connectorId ?? list[0]?.id ?? null;
  const target = list.find((t) => t.id === choice);
  const pitr = target?.protocol === "s3";

  const submit = async () => {
    setStarting(true);
    setError(null);
    try {
      const body =
        choice === OFF ? { connectorId: null } : { connectorId: choice!, schedule: schedule.trim(), retention };
      onStarted((await apiRequest("PUT /api/postgres/backups", { body })).id);
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
          Add an S3/MinIO bucket, NFS export or SMB share under{" "}
          <Anchor href="#/admin/connectors">Admin &gt; Connectors</Anchor> first.
        </Alert>
      ) : null}
      {list.length > 0 ? (
        <Select
          label="Back up Postgres to"
          data={[
            ...list.map((t) => ({ value: t.id, label: `${t.name} (${t.protocol.toUpperCase()})` })),
            ...(current.method !== "none" ? [{ value: OFF, label: "Nowhere (turn backups off)" }] : []),
          ]}
          value={choice}
          onChange={setPicked}
          allowDeselect={false}
        />
      ) : null}
      {target ? (
        <Text size="sm">
          {pitr
            ? "Object storage: base backups on the schedule and every WAL segment as it fills, so a restore can reach any moment."
            : "NFS and SMB take no WAL archive: a dump of every database on the schedule, onto a Longhorn volume that Longhorn backs up to this target. A restore goes back to a dump."}
        </Text>
      ) : null}
      {choice && choice !== OFF ? (
        <Group grow>
          <TextInput
            label="Schedule (cron, UTC)"
            value={schedule}
            onChange={(e) => setSchedule(e.currentTarget.value)}
          />
          <NumberInput
            label={pitr ? "Days kept" : "Dumps kept"}
            min={1}
            max={pitr ? 365 : 60}
            value={retention}
            onChange={(v) => setRetention(typeof v === "number" ? v : DEFAULT_RETENTION)}
          />
        </Group>
      ) : null}
      {error ? <Alert color="red">{error}</Alert> : null}
      <Group justify="flex-end">
        <Button onClick={() => void submit()} loading={starting} disabled={!choice}>
          {choice === OFF ? "Turn off" : "Save"}
        </Button>
      </Group>
    </Stack>
  );
}

// "2026-10-06 10:42" (UTC) -> ISO-8601; undefined until it reads as a moment.
export function parseMoment(text: string): string | undefined {
  const m = /^\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?\s*$/.exec(text);
  if (!m) return undefined;
  const at = new Date(`${m[1]}T${m[2]}:${m[3] ?? "00"}Z`);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

function RestoreDialog({
  current,
  cluster,
  onStarted,
}: {
  current: PostgresBackupView;
  cluster: string;
  onStarted: (id: string) => void;
}) {
  const dumps = current.restorePoints.filter((p) => p.kind === "dump" && p.state === "completed");
  const [moment, setMoment] = useState("");
  const [dumpId, setDumpId] = useState<string | null>(dumps[0]?.id ?? null);
  const [plan, setPlan] = useState<DeployActionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const at = parseMoment(moment);
  const body = current.method === "pitr" ? (at ? { at } : undefined) : dumpId ? { dumpId } : undefined;

  const go = async (run: boolean) => {
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      if (run) onStarted((await apiRequest("POST /api/postgres/restore", { body })).id);
      else setPlan(await apiRequest("POST /api/postgres/restore/plan", { body }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="sm">
      <Text size="sm">
        The restore makes a new cluster and moves the apps to it; {cluster} is stopped and kept until you delete it.
      </Text>
      {current.method === "pitr" ? (
        <TextInput
          label="Restore to (UTC)"
          placeholder="2026-10-06 10:42"
          description={
            current.firstRecoverabilityPoint
              ? `Any moment since ${absoluteTime(current.firstRecoverabilityPoint)}`
              : undefined
          }
          value={moment}
          onChange={(e) => {
            setMoment(e.currentTarget.value);
            setPlan(null);
          }}
          error={moment && !at ? "Write it as YYYY-MM-DD HH:MM" : undefined}
        />
      ) : (
        <Select
          label="Restore the dump of"
          data={dumps.map((d) => ({ value: d.id, label: `${absoluteTime(d.at)} (${relativeTime(d.at)})` }))}
          value={dumpId}
          onChange={(v) => {
            setDumpId(v);
            setPlan(null);
          }}
          allowDeselect={false}
        />
      )}
      {plan ? <ActionPlanView plan={plan} /> : null}
      {error ? <Alert color="red">{error}</Alert> : null}
      <Group justify="flex-end">
        {plan?.allowed ? (
          <Button color="red" loading={busy} onClick={() => void go(true)}>
            Restore
          </Button>
        ) : (
          <Button loading={busy} disabled={!body} onClick={() => void go(false)}>
            Review the restore
          </Button>
        )}
      </Group>
    </Stack>
  );
}

function RemoveDialog({ name, onStarted }: { name: string; onStarted: (id: string) => void }) {
  const [plan, setPlan] = useState<DeployActionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = { kind: "pg-remove-cluster" as const, name };
  const go = async (run: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (run) onStarted((await apiRequest("POST /api/deploy/actions/run", { body: request })).id);
      else setPlan(await apiRequest("POST /api/deploy/actions/plan", { body: request }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="sm">
      {plan ? (
        <ActionPlanView plan={plan} />
      ) : (
        <Text size="sm">{name} and its volumes are deleted. Review what goes first.</Text>
      )}
      {error ? <Alert color="red">{error}</Alert> : null}
      <Group justify="flex-end">
        {plan?.allowed ? (
          <Button color="red" loading={busy} onClick={() => void go(true)}>
            Delete {name}
          </Button>
        ) : (
          <Button loading={busy} onClick={() => void go(false)}>
            Review
          </Button>
        )}
      </Group>
    </Stack>
  );
}

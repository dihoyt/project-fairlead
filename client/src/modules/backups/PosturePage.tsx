import { useMemo, useState } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  Select,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from "@mantine/core";
import { IconDownload, IconRefresh, IconSearch, IconShieldCheck } from "@tabler/icons-react";
import type { BackupPosture, PostureRow } from "@contracts/backups";
import type { Status } from "@contracts/health";
import { PageHeader } from "../../shell/PageHeader";
import { BackupTargetCard } from "./BackupTarget";
import { SchedulesCard } from "./Schedules";
import { VolumeActions } from "./VolumeActions";
import {
  StatusBadge,
  absoluteTime,
  apiRequest,
  formatValue,
  isFailing,
  pageUrl,
  relativeTime,
  useApi,
  useSession,
  worstStatus,
} from "../../ui";

const AGE_COLOR: Record<Status, string> = {
  ok: "dimmed",
  absent: "dimmed",
  unknown: "dimmed",
  warn: "yellow",
  crit: "red",
};

type View = "all" | "risk" | "unprotected" | "ok";

const pvcName = (row: PostureRow) => `${row.pvc.namespace}/${row.pvc.name}`;
const isUnprotected = (row: PostureRow) => !row.protected && row.status !== "absent";

export function overall(rows: PostureRow[]): { status: Status; label: string } {
  const status = worstStatus(rows.map((r) => r.status));
  if (rows.length === 0) return { status: "absent", label: "No PVCs" };
  if (status === "ok" || status === "absent") return { status: "ok", label: "Recoverable" };
  if (status === "unknown") return { status, label: "Unknown" };
  return { status, label: "At risk" };
}

function matchesView(row: PostureRow, view: View): boolean {
  if (view === "unprotected") return isUnprotected(row);
  if (view === "risk") return isFailing(row.status);
  if (view === "ok") return row.status === "ok";
  return true;
}

function downloadJson(posture: BackupPosture) {
  const blob = new Blob([JSON.stringify(posture, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `backup-posture-${posture.generatedAt.slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <Card withBorder padding="sm">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text size="xl" fw={700} c={color}>
        {value}
      </Text>
    </Card>
  );
}

function PolicyCell({ row }: { row: PostureRow }) {
  if (row.coverage.length === 0) {
    return (
      <Text size="sm" c={row.status === "absent" ? "dimmed" : "red"}>
        {row.status === "absent" ? "None (ignored)" : "None"}
      </Text>
    );
  }
  return (
    <Stack gap={2}>
      {row.coverage.map((c, i) => (
        <Group key={`${c.sourceId}-${i}`} gap={6} wrap="nowrap">
          <Badge size="xs" variant="outline" radius="xs" style={{ flexShrink: 0, overflow: "visible" }}>
            {c.sourceId}
          </Badge>
          <Text size="sm" lineClamp={1} title={c.policy.description}>
            {c.policy.description}
          </Text>
          {c.policy.certainty === "probable" ? (
            <Tooltip label="The source could not fully prove this PVC is covered, e.g. a selector it only partly resolved.">
              <Badge
                size="xs"
                color="yellow"
                variant="light"
                radius="xs"
                style={{ flexShrink: 0, overflow: "visible" }}
              >
                probably
              </Badge>
            </Tooltip>
          ) : null}
        </Group>
      ))}
    </Stack>
  );
}

function TargetCell({ row }: { row: PostureRow }) {
  if (!row.target) return <Text size="sm">–</Text>;
  const { free, total } = row.target;
  return (
    <Stack gap={0}>
      <Text size="sm" lineClamp={1} title={row.target.url ?? row.target.label}>
        {row.target.label}
      </Text>
      <Text size="xs" c="dimmed">
        {free !== undefined && total
          ? `${formatValue(free, "bytes")} free of ${formatValue(total, "bytes")} (${Math.round((free / total) * 100)}%)`
          : "Free space not reported"}
      </Text>
    </Stack>
  );
}

function RestoreCell({ row, canMark, onMark }: { row: PostureRow; canMark: boolean; onMark(): void }) {
  const tested = row.restoreTested;
  return (
    <Group gap="xs" wrap="nowrap">
      {tested ? (
        <Tooltip
          label={`${absoluteTime(tested.at)} · ${
            tested.from === "manual"
              ? `marked by hand${tested.note ? `: ${tested.note}` : ""}`
              : `evidence: ${tested.ref}`
          }`}
          multiline
          maw={360}
        >
          <Text size="sm">{relativeTime(tested.at)}</Text>
        </Tooltip>
      ) : (
        <Text size="sm" c="dimmed">
          Never
        </Text>
      )}
      {canMark ? (
        <Button size="compact-xs" variant="subtle" onClick={onMark}>
          Mark tested
        </Button>
      ) : null}
    </Group>
  );
}

function MarkTestedModal({ row, onClose, onSaved }: { row: PostureRow; onClose(): void; onSaved(): void }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await apiRequest("POST /api/backups/volumes/:uid/restore-tests", {
        params: { uid: row.pvc.uid },
        body: { at: date, note },
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal opened onClose={onClose} title={`Restore tested: ${pvcName(row)}`}>
      <Stack gap="sm">
        <TextInput
          type="date"
          label="Tested on"
          value={date}
          onChange={(e) => setDate(e.currentTarget.value)}
          required
        />
        <Textarea
          label="Note"
          description="What was restored, where to, and how it was checked."
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          maxLength={1000}
          autosize
          minRows={2}
        />
        {error ? <Alert color="red">{error}</Alert> : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!date}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function PosturePage() {
  const { me } = useSession();
  const { data, error, loading, reload } = useApi("GET /api/backups/posture", undefined, { pollMs: 30_000 });
  const [view, setView] = useState<View>("all");
  const [search, setSearch] = useState("");
  const [namespace, setNamespace] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [marking, setMarking] = useState<PostureRow | null>(null);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const unprotected = rows.filter(isUnprotected);
  const namespaces = useMemo(() => [...new Set(rows.map((r) => r.pvc.namespace))].toSorted(), [rows]);
  const needle = search.trim().toLowerCase();
  const visible = rows.filter(
    (row) =>
      matchesView(row, view) &&
      (!namespace || row.pvc.namespace === namespace) &&
      (!source || (source === "none" ? row.coverage.length === 0 : row.coverage.some((c) => c.sourceId === source))) &&
      (!needle || `${pvcName(row)} ${row.app ?? ""}`.toLowerCase().includes(needle))
  );
  const summary = overall(rows);

  return (
    <Stack gap="md">
      <PageHeader
        title="Backups"
        description="Every PVC, what backs it up, and whether it could be restored today."
        actions={
          <Group gap="xs">
            <Button
              size="xs"
              variant="default"
              leftSection={<IconRefresh size={14} />}
              onClick={reload}
              loading={loading && !!data}
            >
              Refresh
            </Button>
            <Button
              size="xs"
              variant="default"
              component="a"
              href={pageUrl("api/backups/posture.csv")}
              leftSection={<IconDownload size={14} />}
            >
              CSV
            </Button>
            <Button
              size="xs"
              variant="default"
              leftSection={<IconDownload size={14} />}
              disabled={!data}
              onClick={() => data && downloadJson(data)}
            >
              JSON
            </Button>
          </Group>
        }
      />

      {error ? (
        <Alert color="red" title="Could not load the backup posture">
          {error}
        </Alert>
      ) : null}
      {loading && !data ? <Loader size="sm" /> : null}
      {data?.target ? (
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <BackupTargetCard target={data.target} canEdit={me.admin} onChanged={reload} />
          <SchedulesCard canEdit={me.admin} onChanged={reload} />
        </SimpleGrid>
      ) : null}

      {data ? (
        <>
          <Group gap="sm">
            <StatusBadge status={summary.status} label={summary.label} />
            {data.sources.map((s) => (
              <Tooltip key={s.id} label={s.error ?? ""} disabled={s.state !== "error"}>
                <Badge
                  variant={s.state === "absent" ? "outline" : "light"}
                  color={s.state === "ok" ? "teal" : s.state === "error" ? "red" : "gray"}
                  radius="xs"
                >
                  {s.label}:{" "}
                  {s.state === "ok"
                    ? `${s.volumes} ${s.volumes === 1 ? "volume" : "volumes"}`
                    : s.state === "absent"
                      ? "not installed"
                      : "error"}
                </Badge>
              </Tooltip>
            ))}
            {data.sources.length === 0 ? (
              <Text size="sm" c="dimmed">
                No backup system is reporting.
              </Text>
            ) : null}
            <Text size="xs" c="dimmed">
              Updated {relativeTime(data.generatedAt)}
            </Text>
          </Group>

          <SimpleGrid cols={{ base: 2, sm: 4 }}>
            <Stat label="PVCs" value={rows.length} />
            <Stat label="Protected" value={rows.filter((r) => r.protected).length} />
            <Stat label="Unprotected" value={unprotected.length} color={unprotected.length ? "red" : undefined} />
            <Stat
              label="At risk"
              value={rows.filter((r) => r.protected && isFailing(r.status)).length}
              color={rows.some((r) => r.protected && isFailing(r.status)) ? "yellow" : undefined}
            />
          </SimpleGrid>

          {unprotected.length > 0 ? (
            <Alert
              color={unprotected.some((r) => r.status === "crit") ? "red" : "gray"}
              title={`${unprotected.length} ${unprotected.length === 1 ? "PVC has" : "PVCs have"} no backup`}
            >
              <Stack gap={4}>
                {unprotected.slice(0, 8).map((row) => (
                  <Text key={row.pvc.uid || pvcName(row)} size="sm">
                    <Text span fw={600}>
                      {pvcName(row)}
                    </Text>
                    {row.app ? ` · ${row.app}` : ""}
                    {row.pvc.sizeBytes !== undefined ? ` · ${formatValue(row.pvc.sizeBytes, "bytes")}` : ""}
                    {row.status === "unknown" ? ` · ${row.ageDetail}` : ""}
                  </Text>
                ))}
                {unprotected.length > 8 ? (
                  <Anchor size="sm" component="button" onClick={() => setView("unprotected")}>
                    Show all {unprotected.length}
                  </Anchor>
                ) : null}
              </Stack>
            </Alert>
          ) : rows.length > 0 ? (
            <Alert color="teal" icon={<IconShieldCheck size={18} />}>
              Every PVC is covered by a backup.
            </Alert>
          ) : null}

          <Group gap="sm" wrap="wrap">
            <SegmentedControl
              size="xs"
              value={view}
              onChange={(v) => setView(v as View)}
              data={[
                { label: "All", value: "all" },
                { label: "At risk", value: "risk" },
                { label: "Unprotected", value: "unprotected" },
                { label: "OK", value: "ok" },
              ]}
            />
            <Select
              size="xs"
              placeholder="Namespace"
              data={namespaces}
              value={namespace}
              onChange={setNamespace}
              clearable
              searchable
              w={180}
            />
            <Select
              size="xs"
              placeholder="Source"
              data={[
                ...data.sources.filter((s) => s.state !== "absent").map((s) => ({ label: s.label, value: s.id })),
                { label: "None", value: "none" },
              ]}
              value={source}
              onChange={setSource}
              clearable
              w={150}
            />
            <TextInput
              size="xs"
              placeholder="Search PVC or app"
              leftSection={<IconSearch size={14} />}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              w={220}
            />
          </Group>

          <Table.ScrollContainer minWidth={1000}>
            <Table verticalSpacing="xs" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>PVC</Table.Th>
                  <Table.Th>Size</Table.Th>
                  <Table.Th>Policy</Table.Th>
                  <Table.Th>Last good backup</Table.Th>
                  <Table.Th>Target</Table.Th>
                  <Table.Th>Restore tested</Table.Th>
                  {me.admin ? <Table.Th /> : null}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {visible.map((row) => (
                  <Table.Tr key={row.pvc.uid || pvcName(row)} data-status={row.status}>
                    <Table.Td style={{ whiteSpace: "nowrap" }} w={110}>
                      <StatusBadge status={row.status} label={row.status === "absent" ? "Ignored" : undefined} />
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" fw={600}>
                        {pvcName(row)}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {row.app ?? "Not mounted"}
                        {row.pvc.storageClass ? ` · ${row.pvc.storageClass}` : ""}
                        {row.groups ? ` · ${row.groups.join(", ")}` : ""}
                      </Text>
                    </Table.Td>
                    <Table.Td style={{ whiteSpace: "nowrap" }}>
                      <Text size="sm">
                        {row.pvc.sizeBytes !== undefined ? formatValue(row.pvc.sizeBytes, "bytes") : "–"}
                      </Text>
                    </Table.Td>
                    <Table.Td maw={320}>
                      <PolicyCell row={row} />
                    </Table.Td>
                    <Table.Td>
                      {row.lastGood ? (
                        <Tooltip label={`${absoluteTime(row.lastGood.at)} · ${row.lastGood.ref}`}>
                          <Text size="sm">{relativeTime(row.lastGood.at)}</Text>
                        </Tooltip>
                      ) : (
                        <Text size="sm" c="dimmed">
                          Never
                        </Text>
                      )}
                      <Text size="xs" c={AGE_COLOR[row.ageStatus]} lineClamp={2}>
                        {row.ageDetail}
                      </Text>
                    </Table.Td>
                    <Table.Td maw={260}>
                      <TargetCell row={row} />
                    </Table.Td>
                    <Table.Td>
                      <RestoreCell
                        row={row}
                        canMark={me.admin && row.protected && !!row.pvc.uid}
                        onMark={() => setMarking(row)}
                      />
                    </Table.Td>
                    {me.admin ? (
                      <Table.Td>
                        <VolumeActions row={row} schedules={data.schedules ?? []} onChanged={reload} />
                      </Table.Td>
                    ) : null}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          {visible.length === 0 ? (
            <Text size="sm" c="dimmed">
              {rows.length === 0 ? "No PVCs in the cluster." : "No PVCs match these filters."}
            </Text>
          ) : null}
        </>
      ) : null}

      {marking ? (
        <MarkTestedModal
          row={marking}
          onClose={() => setMarking(null)}
          onSaved={() => {
            setMarking(null);
            reload();
          }}
        />
      ) : null}
    </Stack>
  );
}

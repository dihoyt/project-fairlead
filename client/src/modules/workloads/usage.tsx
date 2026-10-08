import { Sparkline } from "@mantine/charts";
import { Group, Progress, SegmentedControl, Stack, Table, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconArrowDown, IconArrowUp, IconSelector } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import type { ResourceUsage, UsageRange } from "@contracts/workloads";
import { formatValue } from "../../ui";

export const USAGE_RANGES: readonly UsageRange[] = ["1h", "24h", "7d"];
export const USAGE_POLL_MS = 30_000;

// The range lives in the URL beside the tab, so a link keeps it.
export function useUsageRange(): [UsageRange, (range: UsageRange) => void] {
  const [search, setSearch] = useSearchParams();
  const value = search.get("range");
  const range = (USAGE_RANGES as readonly string[]).includes(value ?? "") ? (value as UsageRange) : "1h";
  const set = (next: UsageRange) =>
    setSearch(
      (prev) => {
        const out = new URLSearchParams(prev);
        if (next === "1h") out.delete("range");
        else out.set("range", next);
        return out;
      },
      { replace: true }
    );
  return [range, set];
}

export function RangePicker({ value, onChange }: { value: UsageRange; onChange: (range: UsageRange) => void }) {
  return (
    <SegmentedControl
      size="xs"
      aria-label="Usage range"
      value={value}
      onChange={(v) => onChange(v as UsageRange)}
      data={USAGE_RANGES.map((r) => ({ value: r, label: r }))}
    />
  );
}

export type Resource = "cpu" | "memory";

export function formatCpu(cores: number): string {
  if (cores < 1) return `${Math.round(cores * 1000)}m`;
  return `${cores.toFixed(cores < 10 ? 2 : 1)} cores`;
}

export function formatUsage(resource: Resource, value: number): string {
  return resource === "cpu" ? formatCpu(value) : formatValue(value, "bytes");
}

// What a row shows and sorts by: now when there is a fresh sample, else the
// range's mean.
export function shownValue(usage: ResourceUsage | undefined): number | undefined {
  return usage?.current ?? usage?.avg;
}

// Against the limit when there is one, since that is where the container is
// throttled or killed; else against the request.
export function judge(usage: ResourceUsage): { against?: "limit" | "request"; ratio?: number; color: string } {
  const value = shownValue(usage);
  const against = usage.limit ? "limit" : usage.request ? "request" : undefined;
  if (value === undefined || !against) return { ...(against ? { against } : {}), color: "cyan" };
  const ratio = value / usage[against]!;
  const overRequest = usage.request !== undefined && value > usage.request;
  const color = against === "limit" && ratio >= 0.9 ? "red" : overRequest || ratio > 1 ? "yellow" : "cyan";
  return { against, ratio, color };
}

function Detail({ resource, usage }: { resource: Resource; usage: ResourceUsage }) {
  const row = (label: string, value: number | undefined) => (
    <Group justify="space-between" gap="lg" key={label}>
      <Text size="xs">{label}</Text>
      <Text size="xs" ff="monospace">
        {value === undefined ? "—" : formatUsage(resource, value)}
      </Text>
    </Group>
  );
  return (
    <Stack gap={2}>
      {row("Now", usage.current)}
      {row("Average", usage.avg)}
      {row("Peak", usage.peak)}
      {row("Request", usage.request)}
      {row("Limit", usage.limit)}
    </Stack>
  );
}

// The value, then a bar against the limit or request with the request
// marked when both exist.
export function UsageBar({ resource, usage }: { resource: Resource; usage: ResourceUsage | undefined }) {
  if (!usage) return <Text c="dimmed">—</Text>;
  const value = shownValue(usage);
  const { against, ratio, color } = judge(usage);
  const caption =
    against && usage[against] !== undefined ? `of ${formatUsage(resource, usage[against]!)} ${against}` : "no request";
  return (
    <Tooltip label={<Detail resource={resource} usage={usage} />} withArrow>
      <Stack gap={4} miw={120} maw={180}>
        <Group gap={6} wrap="nowrap" justify="space-between">
          <Text size="sm" ff="monospace" style={{ whiteSpace: "nowrap" }}>
            {value === undefined ? "—" : formatUsage(resource, value)}
          </Text>
          <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
            {caption}
          </Text>
        </Group>
        {ratio !== undefined ? (
          <Progress
            size="sm"
            radius="xs"
            color={color}
            value={Math.min(ratio * 100, 100)}
            aria-label={`${resource} ${Math.round(ratio * 100)}% of ${against}`}
          />
        ) : null}
      </Stack>
    </Tooltip>
  );
}

export function MiniSpark({ points }: { points?: [number, number][] }) {
  if (!points || points.length < 2) {
    return (
      <Text size="xs" c="dimmed">
        no data
      </Text>
    );
  }
  return (
    <Sparkline w={90} h={24} data={points.map(([, v]) => v)} curveType="monotone" color="cyan" fillOpacity={0.2} />
  );
}

export type SortDir = "asc" | "desc";
export interface Sort<K extends string> {
  key: K;
  dir: SortDir;
}

// A header that sorts its column; numbers start descending, names ascending.
export function SortHeader<K extends string>({
  label,
  column,
  sort,
  onSort,
  numeric = false,
}: {
  label: ReactNode;
  column: K;
  sort: Sort<K> | null;
  onSort: (sort: Sort<K>) => void;
  numeric?: boolean;
}) {
  const active = sort?.key === column;
  const Icon = !active ? IconSelector : sort.dir === "asc" ? IconArrowUp : IconArrowDown;
  const next: SortDir = active ? (sort.dir === "asc" ? "desc" : "asc") : numeric ? "desc" : "asc";
  return (
    <Table.Th aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
      <UnstyledButton onClick={() => onSort({ key: column, dir: next })}>
        <Group gap={4} wrap="nowrap">
          <Text size="sm" fw={700}>
            {label}
          </Text>
          <Icon size={14} />
        </Group>
      </UnstyledButton>
    </Table.Th>
  );
}

// Missing values sort last whichever way.
export function compareMaybe(a: number | undefined, b: number | undefined, dir: SortDir): number {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  return dir === "asc" ? a - b : b - a;
}

export function NotCollected({ collected }: { collected: boolean | undefined }) {
  if (collected !== false) return null;
  return (
    <Text size="xs" c="dimmed">
      No CPU or memory samples yet: the node metrics collector has not read the kubelet or metrics-server. Requests and
      limits are still shown.
    </Text>
  );
}

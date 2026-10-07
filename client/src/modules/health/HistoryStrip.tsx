import { Box, Group, Text, Tooltip } from "@mantine/core";
import type { CheckHistoryPoint } from "@contracts/health";
import { STATUS_COLOR } from "../../ui";
import { useApi } from "./api";

const WINDOW_MS = 86_400_000;

// The last 24h of one check as coloured segments, each lasting until the
// next recorded point.
export function HistoryStrip({ providerId, checkId }: { providerId: string; checkId: string }) {
  const path = `api/health/history/${encodeURIComponent(providerId)}/${encodeURIComponent(checkId)}`;
  const { data, error } = useApi("GET /api/health/history/:providerId/:checkId", path, 60_000);
  if (error)
    return (
      <Text size="xs" c="red">
        {error}
      </Text>
    );
  const points = data?.points ?? [];
  if (points.length === 0)
    return (
      <Text size="xs" c="dimmed">
        No history in the last 24h
      </Text>
    );

  const end = Date.now();
  const start = end - WINDOW_MS;
  const segments = points.map((point: CheckHistoryPoint, i) => {
    const from = Math.max(start, Date.parse(point.at));
    const to = i + 1 < points.length ? Date.parse(points[i + 1]!.at) : end;
    return { point, width: Math.max(0, (to - from) / WINDOW_MS) * 100, offset: ((from - start) / WINDOW_MS) * 100 };
  });

  return (
    <Group gap={4} wrap="nowrap" align="center">
      <Text size="xs" c="dimmed" w={32}>
        24h
      </Text>
      <Box pos="relative" h={8} style={{ flex: 1, borderRadius: 2, background: "var(--mantine-color-default-border)" }}>
        {segments.map(({ point, width, offset }) => (
          <Tooltip
            key={`${point.at}-${point.status}`}
            label={`${new Date(point.at).toLocaleString()} · ${point.status} · ${point.detail}`}
          >
            <Box
              pos="absolute"
              top={0}
              h={8}
              left={`${offset}%`}
              w={`${width}%`}
              bg={`${STATUS_COLOR[point.status]}.6`}
            />
          </Tooltip>
        ))}
      </Box>
    </Group>
  );
}

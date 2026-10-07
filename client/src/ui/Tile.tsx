import { Card, Group, Stack, Text } from "@mantine/core";
import { Link } from "react-router";
import type { TileProps } from "./contracts";
import { StatusBadge } from "./StatusBadge";
import { STATUS_COLOR } from "./status";

export function Tile({ title, status, summary, count, to }: TileProps) {
  const issues = count ? count.crit + count.warn : 0;
  const card = (
    <Card
      withBorder
      padding="md"
      h="100%"
      data-status={status}
      style={{
        borderLeft: `3px solid var(--mantine-color-${STATUS_COLOR[status]}-${status === "absent" ? 7 : 6})`,
        opacity: status === "absent" ? 0.7 : 1,
      }}
    >
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Text fw={600} truncate>
            {title}
          </Text>
          <StatusBadge status={status} />
        </Group>
        <Text size="sm" c="dimmed" lineClamp={2}>
          {summary}
        </Text>
        {count && issues > 0 ? (
          <Group gap="sm">
            {count.crit > 0 ? (
              <Text size="xs" c="red">
                {count.crit} critical
              </Text>
            ) : null}
            {count.warn > 0 ? (
              <Text size="xs" c="yellow">
                {count.warn} warning
              </Text>
            ) : null}
          </Group>
        ) : null}
      </Stack>
    </Card>
  );
  return to ? (
    <Link to={to} style={{ textDecoration: "none", color: "inherit", display: "block", height: "100%" }}>
      {card}
    </Link>
  ) : (
    card
  );
}

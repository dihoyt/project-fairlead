import { Anchor, Code, Group, Stack, Text, Tooltip } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import type { CheckListProps } from "./contracts";
import { StatusBadge } from "./StatusBadge";
import { isFailing } from "./status";
import { absoluteTime, relativeTime } from "./time";

export function CheckList({ results, showRaw = "failures" }: CheckListProps) {
  if (results.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No checks.
      </Text>
    );
  }
  return (
    <Stack gap="sm">
      {results.map((result) => {
        const raw =
          result.raw !== undefined && (showRaw === "always" || (showRaw === "failures" && isFailing(result.status)));
        return (
          <Stack key={result.id} gap={4} data-check={result.id}>
            <Group gap="sm" wrap="nowrap" align="flex-start">
              <StatusBadge status={result.status} />
              <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                <Group gap="xs" wrap="nowrap">
                  <Text fw={500} size="sm">
                    {result.label}
                  </Text>
                  {result.deepLink ? (
                    <Anchor href={result.deepLink} target="_blank" rel="noreferrer" size="xs" aria-label="Open">
                      <IconExternalLink size={14} stroke={1.5} />
                    </Anchor>
                  ) : null}
                </Group>
                <Text size="sm" c="dimmed">
                  {result.detail}
                </Text>
              </Stack>
              <Tooltip label={absoluteTime(result.observedAt)} withinPortal>
                <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                  {relativeTime(result.observedAt)}
                </Text>
              </Tooltip>
            </Group>
            {raw ? (
              <Code block fz="xs" style={{ maxHeight: 240, overflow: "auto" }}>
                {typeof result.raw === "string" ? result.raw : JSON.stringify(result.raw, null, 2)}
              </Code>
            ) : null}
          </Stack>
        );
      })}
    </Stack>
  );
}

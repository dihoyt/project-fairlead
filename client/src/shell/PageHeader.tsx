import type { ReactNode } from "react";
import { Group, Stack, Text, Title } from "@mantine/core";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Group justify="space-between" align="flex-start" mb="lg" wrap="wrap">
      <Stack gap={2}>
        <Title order={2}>{title}</Title>
        {description ? (
          <Text size="sm" c="dimmed">
            {description}
          </Text>
        ) : null}
      </Stack>
      {actions}
    </Group>
  );
}

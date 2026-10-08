import { Group, Text } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import type { WhatIsThisProps } from "../contracts";

export function WhatIsThis({ children }: WhatIsThisProps) {
  return (
    <Group gap={6} wrap="nowrap" align="flex-start" data-what-is-this>
      <IconInfoCircle size={16} stroke={1.5} style={{ flexShrink: 0, marginTop: 2, opacity: 0.7 }} aria-hidden />
      <Text size="sm" c="dimmed">
        {children}
      </Text>
    </Group>
  );
}

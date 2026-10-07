import { Stack, Text, Title } from "@mantine/core";

export function Placeholder({ title, note = "Not built yet." }: { title: string; note?: string }) {
  return (
    <Stack gap="xs">
      <Title order={2}>{title}</Title>
      <Text c="dimmed">{note}</Text>
    </Stack>
  );
}

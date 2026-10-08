import { Group, Text } from "@mantine/core";
import { StatusBadge, useApi } from "../../ui";

// The class volumes get when they name none, as discovery read it.
export function DefaultStorageClass() {
  const { data } = useApi("GET /api/catalog/discovery", undefined, { pollMs: 60_000 });
  const basic = data?.basics.find((b) => b.id === "default-storage-class");
  if (!basic) return null;
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
        Default storage class
      </Text>
      {basic.status === "ok" ? (
        <Text size="sm" fw={500}>
          {basic.found[0]}
        </Text>
      ) : (
        <>
          <StatusBadge status={basic.status} />
          <Text size="sm">{basic.detail}</Text>
        </>
      )}
    </Group>
  );
}

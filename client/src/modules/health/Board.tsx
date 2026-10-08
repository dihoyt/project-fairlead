import { Alert, Group, Loader, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { StatusBadge, Tile } from "../../ui";
import { RaiseReplicas } from "../../ui/deploy";
import { useApi } from "./api";
import { CATEGORY_LABEL, ago } from "./labels";

export function Board() {
  const { data, error, loading } = useApi("GET /api/health/board", "api/health/board");

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Group gap="sm">
          <Title order={2}>Health</Title>
          {data ? <StatusBadge status={data.status} /> : null}
        </Group>
        {data ? (
          <Text size="xs" c="dimmed">
            Updated {ago(data.generatedAt)}
          </Text>
        ) : null}
      </Group>
      <RaiseReplicas />
      {error ? (
        <Alert color="red" title="Could not load the health board">
          {error}
        </Alert>
      ) : null}
      {loading && !data ? <Loader size="sm" /> : null}
      {data ? (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
          {data.tiles.map((tile) => (
            <Tile
              key={tile.category}
              title={CATEGORY_LABEL[tile.category]}
              status={tile.status}
              summary={tile.summary}
              count={{ warn: tile.counts.warn, crit: tile.counts.crit }}
              to={`/health/${tile.category}`}
            />
          ))}
        </SimpleGrid>
      ) : null}
    </Stack>
  );
}

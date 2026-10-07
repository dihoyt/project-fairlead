import { useState } from "react";
import { Alert, Anchor, Button, Card, Code, Collapse, Group, Loader, Stack, Text, Title } from "@mantine/core";
import { IconArrowLeft, IconExternalLink, IconRefresh } from "@tabler/icons-react";
import { Link, useParams } from "react-router";
import type { Category, CheckResult, ProviderState } from "@contracts/health";
import { CheckList, StatusBadge, isFailing } from "../../ui";
import { call, useApi } from "./api";
import { HistoryStrip } from "./HistoryStrip";
import { CATEGORY_LABEL, ago, objectLabel, workloadRoute } from "./labels";

function WorkloadLinks({ result }: { result: CheckResult }) {
  const route = workloadRoute(result.object);
  if (!route && !result.deepLink) return null;
  return (
    <Group gap="md">
      {route && result.object ? (
        <Anchor component={Link} to={route} size="xs">
          {objectLabel(result.object)}
        </Anchor>
      ) : null}
      {result.deepLink ? (
        <Anchor href={result.deepLink} target="_blank" rel="noreferrer" size="xs">
          <Group gap={4}>
            Open in native UI
            <IconExternalLink size={12} />
          </Group>
        </Anchor>
      ) : null}
    </Group>
  );
}

// A failing check's raw data stays one click away rather than inline, so a
// category with many failures (one per PVC, say) stays readable.
export function RawData({ result }: { result: CheckResult }) {
  const [open, setOpen] = useState(false);
  if (result.raw === undefined || !isFailing(result.status)) return null;
  return (
    <Stack gap={4}>
      <Anchor component="button" type="button" size="xs" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? "Hide raw data" : "Show raw data"}
      </Anchor>
      <Collapse expanded={open}>
        <Code block fz="xs" style={{ maxHeight: 240, overflow: "auto" }}>
          {typeof result.raw === "string" ? result.raw : JSON.stringify(result.raw, null, 2)}
        </Code>
      </Collapse>
    </Stack>
  );
}

function ProviderCard({ provider, onRan }: { provider: ProviderState; onRan(): void }) {
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string>();
  const runNow = async () => {
    setRunning(true);
    setRunError(undefined);
    try {
      await call(
        "POST /api/health/providers/:providerId/run",
        `api/health/providers/${encodeURIComponent(provider.id)}/run`
      );
      onRan();
    } catch (err) {
      setRunError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card withBorder padding="md">
      <Group justify="space-between" mb="sm">
        <Group gap="sm">
          <Text fw={600}>{provider.label}</Text>
          <StatusBadge status={provider.status} />
        </Group>
        <Group gap="sm">
          <Text size="xs" c="dimmed">
            Last run {ago(provider.lastRunAt)}
          </Text>
          <Button
            size="compact-xs"
            variant="subtle"
            leftSection={<IconRefresh size={14} />}
            loading={running}
            onClick={runNow}
          >
            Run now
          </Button>
        </Group>
      </Group>
      {provider.lastError ? (
        <Alert color="gray" mb="sm" p="xs">
          {provider.lastError}
        </Alert>
      ) : null}
      {runError ? (
        <Alert color="red" mb="sm" p="xs">
          {runError}
        </Alert>
      ) : null}
      {provider.results.length === 0 ? (
        <Text size="sm" c="dimmed">
          No results yet.
        </Text>
      ) : (
        <Stack gap="md">
          {provider.results.map((result) => (
            <Stack key={result.id} gap={4}>
              <CheckList results={[result]} showRaw="never" />
              <WorkloadLinks result={result} />
              <RawData result={result} />
              <HistoryStrip providerId={provider.id} checkId={result.id} />
            </Stack>
          ))}
        </Stack>
      )}
    </Card>
  );
}

export function CategoryPage() {
  const category = useParams().category as Category;
  const { data, error, loading, reload } = useApi(
    "GET /api/health/categories/:category",
    `api/health/categories/${encodeURIComponent(category)}`
  );
  const title = CATEGORY_LABEL[category] ?? category;

  return (
    <Stack gap="md">
      <Anchor component={Link} to="/health" size="sm">
        <Group gap={4}>
          <IconArrowLeft size={14} />
          Health
        </Group>
      </Anchor>
      <Group gap="sm">
        <Title order={2}>{title}</Title>
        {data ? <StatusBadge status={data.status} /> : null}
      </Group>
      {data && data.links.length > 0 ? (
        <Group gap="md">
          {data.links.map((link) => (
            <Anchor key={link.url} href={link.url} target="_blank" rel="noreferrer" size="sm">
              <Group gap={4}>
                {link.label}
                <IconExternalLink size={14} />
              </Group>
            </Anchor>
          ))}
        </Group>
      ) : null}
      {error ? (
        <Alert color="red" title={`Could not load ${title}`}>
          {error}
        </Alert>
      ) : null}
      {loading && !data ? <Loader size="sm" /> : null}
      {data && data.providers.length === 0 ? <Text c="dimmed">Nothing reports into {title} yet.</Text> : null}
      {data?.providers.map((provider) => (
        <ProviderCard key={provider.id} provider={provider} onRan={reload} />
      ))}
    </Stack>
  );
}

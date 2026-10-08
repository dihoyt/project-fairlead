import { useState } from "react";
import { Anchor, Badge, Group, Paper, Stack, Text, Tooltip } from "@mantine/core";
import type { CatalogAppView, CatalogSlot } from "@contracts/catalog";
import type { DeployResult } from "../../ui/contracts";
import { useApi } from "../../ui";
import { DETECT_COLOR, DETECT_LABEL, DeployButton, WhatIsThis } from "../../ui/deploy";

// The catalog with what discovery found for each app, plus the cluster-wide
// report (Ingress hosts, basics, suggested defaults). `refresh` forces the
// server to look again, after a deploy lands.
export function useDiscovery() {
  const [refresh, setRefresh] = useState<"1" | undefined>(undefined);
  const apps = useApi("GET /api/catalog/apps", { query: { refresh } });
  const report = useApi("GET /api/catalog/discovery", { query: { refresh } });
  return {
    apps: apps.data ?? undefined,
    report: report.data ?? undefined,
    loading: (apps.loading && !apps.data) || (report.loading && !report.data),
    error: apps.error ?? report.error,
    app: (id: string) => apps.data?.find((app) => app.id === id),
    inSlot: (slot: CatalogSlot) => (apps.data ?? []).filter((app) => app.slots.includes(slot)),
    refresh: () => {
      setRefresh("1");
      apps.reload();
      report.reload();
    },
  };
}

export type Discovery = ReturnType<typeof useDiscovery>;

// One catalog app inside a step: what it is, whether it is already in the
// cluster, and its URL or a Deploy button. Every deploy goes through the
// shared dialog, which always shows the plan before anything runs.
export function AppOffer({
  app,
  initial,
  onDeployed,
}: {
  app: CatalogAppView;
  initial?: Record<string, string | boolean>;
  onDeployed?: (result: DeployResult) => void;
}) {
  const [deployed, setDeployed] = useState<DeployResult>();
  const { detected } = app;
  const installed = detected.state === "installed" || deployed !== undefined;
  const urls = deployed?.url ? [deployed.url] : detected.urls;
  return (
    <Paper withBorder p="sm" data-offer={app.id} data-detect-state={deployed ? "installed" : detected.state}>
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Group gap="xs">
            <Text fw={600} size="sm">
              {app.name}
            </Text>
            <Tooltip label={deployed ? "Deployed from this page" : detected.evidence} multiline maw={360}>
              <Badge color={installed ? DETECT_COLOR.installed : DETECT_COLOR[detected.state]} variant="light">
                {deployed ? "deployed" : DETECT_LABEL[detected.state]}
              </Badge>
            </Tooltip>
          </Group>
          {installed ? null : (
            <DeployButton
              appId={app.id}
              label={`Deploy ${app.name}`}
              size="xs"
              initial={initial}
              onDeployed={(result) => {
                setDeployed(result);
                onDeployed?.(result);
              }}
            />
          )}
        </Group>
        <WhatIsThis>{app.summary}</WhatIsThis>
        {installed && urls.length ? (
          <Group gap="xs">
            {urls.map((url) => (
              <Anchor key={url} href={url} target="_blank" rel="noreferrer" size="sm">
                {url}
              </Anchor>
            ))}
          </Group>
        ) : null}
        {detected.state === "unknown" && !deployed ? (
          <Text size="xs" c="yellow">
            Could not tell whether it is installed: {detected.evidence}. Check before deploying a second copy.
          </Text>
        ) : null}
      </Stack>
    </Paper>
  );
}

// Shown in place of the offers when the catalog cannot be read; the step
// still works by hand.
export function DiscoveryNote({ discovery }: { discovery: Discovery }) {
  if (discovery.error) {
    return (
      <Text size="xs" c="dimmed">
        Could not look at the cluster for this step ({discovery.error}); fill it in by hand.
      </Text>
    );
  }
  return null;
}

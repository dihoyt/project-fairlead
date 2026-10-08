import { useCallback, useState } from "react";
import { Alert, Anchor, Badge, Button, Card, Group, SimpleGrid, Stack, Text, Title, Tooltip } from "@mantine/core";
import { IconExternalLink, IconRefresh } from "@tabler/icons-react";
import type { CatalogAppView, CatalogSlot } from "@contracts/catalog";
import { useApi } from "../../ui";
import { DETECT_COLOR, DETECT_LABEL, DeployButton, WhatIsThis } from "../../ui/deploy";
import { SLOT_LABEL, SLOT_ORDER } from "./labels";

// An app offered in several slots is listed under its first one only.
export function groupBySlot(apps: CatalogAppView[]): Array<{ slot: CatalogSlot; apps: CatalogAppView[] }> {
  const groups = new Map<CatalogSlot, CatalogAppView[]>();
  for (const app of apps) {
    const slot = app.slots[0];
    if (!slot) continue;
    groups.set(slot, [...(groups.get(slot) ?? []), app]);
  }
  return SLOT_ORDER.filter((slot) => groups.has(slot)).map((slot) => ({ slot, apps: groups.get(slot)! }));
}

function AppCard({
  app,
  names,
  onDeployed,
}: {
  app: CatalogAppView;
  names: Record<string, string>;
  onDeployed: () => void;
}) {
  const { detected } = app;
  return (
    <Card withBorder padding="sm" data-app={app.id} data-detect-state={detected.state}>
      <Stack gap={6} h="100%">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Anchor href={app.homepage} target="_blank" rel="noreferrer" fw={600} c="inherit">
            {app.name}
          </Anchor>
          <Tooltip label={detected.evidence} multiline maw={360}>
            <Badge color={DETECT_COLOR[detected.state]} variant="light" radius="xs">
              {DETECT_LABEL[detected.state]}
            </Badge>
          </Tooltip>
        </Group>
        <WhatIsThis>{app.summary}</WhatIsThis>
        {detected.state === "installed" ? (
          <Text size="xs" c="dimmed">
            {[
              detected.namespace,
              detected.version,
              detected.ownedByUs
                ? "deployed from here"
                : detected.managedBy
                  ? `managed by ${detected.managedBy}`
                  : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        ) : null}
        {detected.urls.map((url) => (
          <Anchor key={url} href={url} target="_blank" rel="noreferrer" size="sm">
            <Group gap={4} wrap="nowrap">
              {url}
              <IconExternalLink size={14} />
            </Group>
          </Anchor>
        ))}
        {detected.state === "unknown" ? (
          <Text size="xs" c="dimmed">
            {detected.evidence}
          </Text>
        ) : null}
        {detected.state !== "installed" && app.requires.length > 0 ? (
          <Text size="xs" c="dimmed">
            Needs {app.requires.map((id) => names[id] ?? id).join(", ")}
          </Text>
        ) : null}
        {detected.state !== "installed" ? (
          <Group mt="auto" pt={4}>
            <DeployButton appId={app.id} size="xs" onDeployed={onDeployed} />
          </Group>
        ) : null}
        {detected.state === "installed" ? (
          <Text size="xs" c="dimmed" mt="auto" pt={4}>
            Upgrade or change it on Apps &gt; Installed.
          </Text>
        ) : null}
      </Stack>
    </Card>
  );
}

// The catalog by slot, with what discovery found and Deploy for the rest.
export function CatalogTab({ onDeployed }: { onDeployed: () => void }) {
  const [refresh, setRefresh] = useState(false);
  const apps = useApi("GET /api/catalog/apps", { query: refresh ? { refresh: "1" } : {} });
  const names = Object.fromEntries((apps.data ?? []).map((app) => [app.id, app.name]));
  const reload = apps.reload;
  const deployed = useCallback(() => {
    setRefresh(true);
    reload();
    onDeployed();
  }, [reload, onDeployed]);
  return (
    <Stack gap="xl">
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          Apps a cluster usually wants, what is already installed, and a way to deploy the rest.
        </Text>
        <Button
          variant="default"
          size="xs"
          leftSection={<IconRefresh size={14} />}
          loading={apps.loading}
          onClick={() => {
            setRefresh(true);
            reload();
          }}
        >
          Look again
        </Button>
      </Group>
      {apps.error ? (
        <Alert color="red" variant="light">
          {apps.error}
        </Alert>
      ) : null}
      {groupBySlot(apps.data ?? []).map(({ slot, apps: inSlot }) => (
        <section key={slot} aria-label={SLOT_LABEL[slot].title}>
          <Title order={4}>{SLOT_LABEL[slot].title}</Title>
          <Text size="sm" c="dimmed" mb="sm">
            {SLOT_LABEL[slot].about}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
            {inSlot.map((app) => (
              <AppCard key={app.id} app={app} names={names} onDeployed={deployed} />
            ))}
          </SimpleGrid>
        </section>
      ))}
    </Stack>
  );
}

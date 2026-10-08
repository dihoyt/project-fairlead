import { useCallback, useContext, useState } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconExternalLink, IconRefresh } from "@tabler/icons-react";
import type { CatalogAppView, CatalogSlot } from "@contracts/catalog";
import type { DeployActionKind, DeployJobView } from "@contracts/deploy";
import { PageHeader } from "../../shell/PageHeader";
import { relativeTime, useApi } from "../../ui";
import { SessionContext } from "../../ui/session";
import {
  DETECT_COLOR,
  DETECT_LABEL,
  DeployButton,
  DeployJobProgress,
  DeploysOff,
  JOB_STATE_COLOR,
  WhatIsThis,
  isFinished,
} from "../../ui/deploy";
import { ConvertToLonghornButton } from "./ConvertToLonghorn";
import { SLOT_LABEL, SLOT_ORDER } from "./labels";
import { UpgradesSection } from "./Upgrades";

const JOBS_POLL_MS = 5_000;

const MODE_LABEL: Record<DeployJobView["mode"] | DeployActionKind, string> = {
  install: "install",
  "dry-run": "dry run",
  upgrade: "upgrade",
  action: "action",
  "longhorn-replicas": "replicas",
  "migrate-to-longhorn": "convert",
  "backup-volumes": "backup",
  "remove-app": "remove",
  "app-gate": "sign-in gate",
};

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
  const admin = useContext(SessionContext)?.me.admin ?? true;
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
        {detected.state === "installed" && detected.ownedByUs && app.storage && admin ? (
          <Group mt="auto" pt={4}>
            <ConvertToLonghornButton appId={app.id} name={app.name} onFinished={onDeployed} />
          </Group>
        ) : null}
      </Stack>
    </Card>
  );
}

function JobsTable({
  jobs,
  names,
  onOpen,
}: {
  jobs: DeployJobView[];
  names: Record<string, string>;
  onOpen: (job: DeployJobView) => void;
}) {
  if (jobs.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        Nothing has been deployed from here yet.
      </Text>
    );
  }
  return (
    <Table.ScrollContainer minWidth={640}>
      <Table verticalSpacing="xs" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>App</Table.Th>
            <Table.Th>State</Table.Th>
            <Table.Th>Release</Table.Th>
            <Table.Th>Started</Table.Th>
            <Table.Th>Result</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {jobs.map((job) => (
            <Table.Tr key={job.id} data-job={job.id}>
              <Table.Td>{names[job.appId] ?? job.appId}</Table.Td>
              <Table.Td>
                <Badge color={JOB_STATE_COLOR[job.state]} variant={isFinished(job.state) ? "light" : "dot"} radius="xs">
                  {job.mode === "install" ? job.state : `${MODE_LABEL[job.action ?? job.mode]} ${job.state}`}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Text size="sm">
                  {job.namespace}/{job.release} {job.version}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm">
                  {relativeTime(job.createdAt)} by {job.startedBy}
                </Text>
              </Table.Td>
              <Table.Td maw={320}>
                <Text size="sm" lineClamp={2} c={job.state === "failed" ? "red" : undefined}>
                  {job.message ?? ""}
                </Text>
              </Table.Td>
              <Table.Td>
                <Button size="compact-xs" variant="subtle" onClick={() => onOpen(job)}>
                  Log
                </Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

export function AppsPage() {
  const [refresh, setRefresh] = useState(false);
  const apps = useApi("GET /api/catalog/apps", { query: refresh ? { refresh: "1" } : {} });
  const status = useApi("GET /api/deploy/status");
  const jobs = useApi("GET /api/deploy/jobs", { query: { limit: "20" } }, { pollMs: JOBS_POLL_MS });
  const [open, setOpen] = useState<DeployJobView | null>(null);

  const names = Object.fromEntries((apps.data ?? []).map((app) => [app.id, app.name]));
  const reloadApps = apps.reload;
  const reloadJobs = jobs.reload;

  const deployed = useCallback(() => {
    setRefresh(true);
    reloadApps();
    reloadJobs();
  }, [reloadApps, reloadJobs]);

  return (
    <>
      <PageHeader
        title="Apps"
        description="Apps a cluster usually wants, what is already installed, and a way to deploy the rest."
        actions={
          <Button
            variant="default"
            size="xs"
            leftSection={<IconRefresh size={14} />}
            loading={apps.loading}
            onClick={() => {
              setRefresh(true);
              reloadApps();
            }}
          >
            Look again
          </Button>
        }
      />
      <Stack gap="xl">
        {status.data && !status.data.enabled ? (
          <Alert color="blue" variant="light" title="Deploys are off">
            <DeploysOff status={status.data} />
          </Alert>
        ) : null}
        {apps.error ? (
          <Alert color="red" variant="light">
            {apps.error}
          </Alert>
        ) : null}
        <UpgradesSection names={names} onFinished={deployed} />
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
        <section aria-label="Recent deploys">
          <Title order={4} mb="sm">
            Recent deploys
          </Title>
          {jobs.error ? (
            <Alert color="red" variant="light" mb="sm">
              {jobs.error}
            </Alert>
          ) : null}
          <JobsTable jobs={jobs.data ?? []} names={names} onOpen={setOpen} />
        </section>
      </Stack>
      <Modal
        opened={open !== null}
        onClose={() => setOpen(null)}
        title={open ? `${names[open.appId] ?? open.appId}: ${open.release}` : ""}
        size="xl"
      >
        {open ? <DeployJobProgress jobId={open.id} onFinished={reloadJobs} /> : null}
      </Modal>
    </>
  );
}

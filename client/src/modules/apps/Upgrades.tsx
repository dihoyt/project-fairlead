import { useContext, useState } from "react";
import { Alert, Badge, Button, Code, Group, List, Modal, Stack, Table, Text, Title, Tooltip } from "@mantine/core";
import { IconArrowUpCircle } from "@tabler/icons-react";
import type { UpgradeCandidate, UpgradeReport, UpgradeState } from "@contracts/deploy";
import { apiRequest, useApi } from "../../ui";
import { DeployRolloutProgress } from "../../ui/deploy";
import { SessionContext } from "../../ui/session";

const STATE_COLOR: Record<UpgradeState, string> = {
  available: "cyan",
  current: "green",
  blocked: "gray",
  unknown: "yellow",
};

const STATE_LABEL: Record<UpgradeState, string> = {
  available: "upgrade available",
  current: "up to date",
  blocked: "can't upgrade",
  unknown: "version unknown",
};

const selectable = (app: UpgradeCandidate) => app.state === "available" || app.state === "unknown";

// What "Upgrade all" covers: unknown versions only when named one by one.
export const upgradeAll = (report: UpgradeReport) => report.apps.filter((app) => app.state === "available");

function FromTo({ app }: { app: UpgradeCandidate }) {
  return (
    <Text size="sm">
      {app.currentVersion ?? "?"} → {app.targetVersion ?? app.pinnedVersion}
      {app.fellBack ? (
        <Text span size="xs" c="dimmed">
          {" "}
          (newest this cluster can run; catalog pins {app.pinnedVersion})
        </Text>
      ) : null}
    </Text>
  );
}

function Preview({
  apps,
  names,
  onStarted,
  onCancel,
}: {
  apps: UpgradeCandidate[];
  names: Record<string, string>;
  onStarted: (runId: string) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Stack gap="md">
      <Text size="sm">
        Each app is upgraded in turn with the settings it was installed with. The run stops at the first failure.
      </Text>
      {apps.map((app) => (
        <Stack key={app.appId} gap={4} data-upgrade-preview={app.appId}>
          <Group gap="xs">
            <Text fw={600}>{names[app.appId] ?? app.appId}</Text>
            <FromTo app={app} />
          </Group>
          {app.state === "unknown" ? (
            <Text size="xs" c="yellow">
              {app.reason ?? "The installed version is unknown."} It is upgraded to {app.targetVersion} anyway.
            </Text>
          ) : null}
          {app.notes.length > 0 ? (
            <Alert color="yellow" variant="light" p="xs" title="Upgrade notes">
              <List size="sm">
                {app.notes.map((note) => (
                  <List.Item key={note.version}>
                    <b>{note.version}:</b> {note.note}
                  </List.Item>
                ))}
              </List>
            </Alert>
          ) : null}
          {app.commands.map((command) => (
            <Code key={command} block>
              {command}
            </Code>
          ))}
        </Stack>
      ))}
      {error ? (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      ) : null}
      <Group justify="flex-end">
        <Button variant="default" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          loading={busy}
          leftSection={<IconArrowUpCircle size={16} />}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const run = await apiRequest("POST /api/deploy/upgrades", {
                body: { appIds: apps.map((app) => app.appId) },
              });
              onStarted(run.id);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {apps.length === 1 ? "Upgrade" : `Upgrade ${apps.length} apps`}
        </Button>
      </Group>
    </Stack>
  );
}

export function UpgradesSection({ names, onFinished }: { names: Record<string, string>; onFinished: () => void }) {
  const session = useContext(SessionContext);
  const admin = session?.me.admin ?? true;
  const report = useApi("GET /api/deploy/upgrades");
  const [picked, setPicked] = useState<UpgradeCandidate[] | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const reload = report.reload;

  const close = () => {
    setPicked(null);
    setRunId(null);
  };

  if (report.error) {
    return (
      <Alert color="red" variant="light">
        {report.error}
      </Alert>
    );
  }
  const data = report.data;
  if (!data || data.apps.length === 0) return null;
  const all = upgradeAll(data);

  return (
    <section aria-label="Upgrades">
      <Group justify="space-between" mb="sm">
        <div>
          <Title order={4}>Upgrades</Title>
          <Text size="sm" c="dimmed">
            Apps deployed from here, against the versions this release of the console ships with. Nothing upgrades by
            itself.
          </Text>
        </div>
        <Tooltip label="Only admins can upgrade apps" disabled={admin}>
          <span>
            <Button
              size="xs"
              leftSection={<IconArrowUpCircle size={14} />}
              disabled={!admin || all.length === 0 || !data.enabled}
              onClick={() => setPicked(all)}
            >
              {all.length === 0 ? "Everything is up to date" : `Upgrade all (${all.length})`}
            </Button>
          </span>
        </Tooltip>
      </Group>
      <Table.ScrollContainer minWidth={640}>
        <Table verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>App</Table.Th>
              <Table.Th>Version</Table.Th>
              <Table.Th>State</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.apps.map((app) => (
              <Table.Tr key={app.appId} data-upgrade={app.appId} data-upgrade-state={app.state}>
                <Table.Td>{names[app.appId] ?? app.appId}</Table.Td>
                <Table.Td>
                  <FromTo app={app} />
                </Table.Td>
                <Table.Td>
                  <Tooltip label={app.reason} disabled={!app.reason} multiline maw={360}>
                    <Badge color={STATE_COLOR[app.state]} variant="light" radius="xs">
                      {STATE_LABEL[app.state]}
                    </Badge>
                  </Tooltip>
                  {app.notes.length > 0 ? (
                    <Text size="xs" c="dimmed">
                      {app.notes.length === 1 ? "1 upgrade note" : `${app.notes.length} upgrade notes`}
                    </Text>
                  ) : null}
                </Table.Td>
                <Table.Td>
                  {selectable(app) ? (
                    <Button
                      size="compact-xs"
                      variant="light"
                      disabled={!admin || !data.enabled}
                      onClick={() => setPicked([app])}
                    >
                      Upgrade
                    </Button>
                  ) : null}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      <Modal
        opened={picked !== null}
        onClose={close}
        title={runId ? "Upgrading" : picked?.length === 1 ? "Upgrade an app" : "Upgrade all"}
        size="xl"
      >
        {runId ? (
          <DeployRolloutProgress
            runId={runId}
            names={names}
            onFinished={() => {
              reload();
              onFinished();
            }}
          />
        ) : picked ? (
          <Preview apps={picked} names={names} onStarted={setRunId} onCancel={close} />
        ) : null}
      </Modal>
    </section>
  );
}

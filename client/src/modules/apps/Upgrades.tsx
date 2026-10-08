import { useContext, useState } from "react";
import { Alert, Badge, Button, Code, Group, List, Modal, Stack, Text, Tooltip } from "@mantine/core";
import { IconArrowUpCircle } from "@tabler/icons-react";
import type { UpgradeCandidate, UpgradeReport, UpgradeState } from "@contracts/deploy";
import { apiRequest } from "../../ui";
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

export function FromTo({ app }: { app: UpgradeCandidate }) {
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

// The preview for the picked apps, then their upgrade run's progress.
export function UpgradeModal({
  apps,
  names,
  onClose,
  onFinished,
}: {
  apps: UpgradeCandidate[] | null;
  names: Record<string, string>;
  onClose: () => void;
  onFinished: () => void;
}) {
  const [runId, setRunId] = useState<string | null>(null);
  const close = () => {
    setRunId(null);
    onClose();
  };
  return (
    <Modal
      opened={apps !== null}
      onClose={close}
      title={runId ? "Upgrading" : apps?.length === 1 ? "Upgrade an app" : "Upgrade all"}
      size="xl"
    >
      {runId ? (
        <DeployRolloutProgress runId={runId} names={names} onFinished={onFinished} />
      ) : apps ? (
        <Preview apps={apps} names={names} onStarted={setRunId} onCancel={close} />
      ) : null}
    </Modal>
  );
}

export function UpgradeStateBadge({ app }: { app: UpgradeCandidate }) {
  return (
    <Tooltip label={app.reason} disabled={!app.reason} multiline maw={360}>
      <Badge color={STATE_COLOR[app.state]} variant="light" radius="xs">
        {STATE_LABEL[app.state]}
      </Badge>
    </Tooltip>
  );
}

export const canUpgrade = selectable;

export function UpgradeAllButton({
  report,
  onPick,
}: {
  report: UpgradeReport | undefined;
  onPick: (apps: UpgradeCandidate[]) => void;
}) {
  const admin = useContext(SessionContext)?.me.admin ?? true;
  const all = report ? upgradeAll(report) : [];
  return (
    <Tooltip label="Only admins can upgrade apps" disabled={admin}>
      <span>
        <Button
          size="xs"
          leftSection={<IconArrowUpCircle size={14} />}
          disabled={!admin || all.length === 0 || !report?.enabled}
          onClick={() => onPick(all)}
        >
          {all.length === 0 ? "Everything is up to date" : `Upgrade all (${all.length})`}
        </Button>
      </span>
    </Tooltip>
  );
}

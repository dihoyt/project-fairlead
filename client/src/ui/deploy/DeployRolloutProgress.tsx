import { useContext, useEffect, useRef, useState } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Loader,
  Progress,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { IconExternalLink, IconPlayerStop } from "@tabler/icons-react";
import type { BundleRunView } from "@contracts/deploy";
import { apiRequest, useApi } from "../api";
import { SessionContext } from "../session";
import { relativeTime } from "../time";
import { DeployJobProgress } from "./DeployJobProgress";
import { SkippedSteps } from "./SkippedSteps";
import { RUN_STATE_COLOR, STEP_STATE_COLOR, STEP_STATE_VARIANT } from "./jobs";

const POLL_MS = 2_000;

export interface DeployRolloutProgressProps {
  // A bundle run from POST /api/deploy/bundles.
  runId: string;
  // Display names by app id; default: the catalog's names.
  names?: Record<string, string>;
  // Called once the run is no longer running.
  onFinished?: (run: BundleRunView) => void;
}

type Step = BundleRunView["steps"][number];

// The step whose log is worth showing unless the user picked another: the
// one running, else the one that failed, else the last that ran.
export function defaultStep(run: BundleRunView): Step | undefined {
  const withJob = run.steps.filter((step) => step.jobId);
  return (
    run.steps.find((step) => step.state === "running" && step.jobId) ??
    run.steps.find((step) => step.state === "failed" && step.jobId) ??
    withJob[withJob.length - 1]
  );
}

export function DeployRolloutProgress({ runId, names, onFinished }: DeployRolloutProgressProps) {
  const session = useContext(SessionContext);
  const [finished, setFinished] = useState(false);
  const run = useApi(
    "GET /api/deploy/bundles/:id",
    { params: { id: runId } },
    { pollMs: finished ? undefined : POLL_MS }
  );
  const catalog = useApi("GET /api/catalog/apps", undefined, { enabled: names === undefined });
  const [cancelled, setCancelled] = useState<BundleRunView | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const reported = useRef<string | null>(null);

  // A poll after the cancel answers with the server's view, which wins.
  const view = run.data && (!cancelled || run.data.state !== "running") ? run.data : (cancelled ?? run.data);
  const done = view !== null && view.state !== "running";
  const label = (appId: string) => names?.[appId] ?? catalog.data?.find((app) => app.id === appId)?.name ?? appId;

  useEffect(() => {
    if (done) setFinished(true);
  }, [done]);

  useEffect(() => {
    if (!view || !done || reported.current === view.id) return;
    reported.current = view.id;
    onFinished?.(view);
  }, [view, done, onFinished]);

  async function cancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      setCancelled(await apiRequest("POST /api/deploy/bundles/:id/cancel", { params: { id: runId } }));
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  }

  if (!view) {
    return run.error ? (
      <Alert color="red" variant="light">
        {run.error}
      </Alert>
    ) : (
      <Group gap="xs">
        <Loader size="xs" />
        <Text size="sm" c="dimmed">
          Loading the rollout…
        </Text>
      </Group>
    );
  }

  const counted = view.steps.filter((step) => step.state !== "skipped");
  const settled = counted.filter((step) => ["succeeded", "failed", "cancelled"].includes(step.state)).length;
  const succeeded = counted.filter((step) => step.state === "succeeded").length;
  const selected = view.steps.find((step) => step.appId === picked && step.jobId) ?? defaultStep(view);
  const canCancel = !done && (session?.me.admin ?? true);

  return (
    <Stack gap="sm" data-run-state={view.state}>
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Group gap="xs" wrap="wrap">
          <Badge color={RUN_STATE_COLOR[view.state]} variant={done ? "light" : "dot"} radius="xs">
            {view.state}
          </Badge>
          <Text size="sm">
            {succeeded} of {counted.length} {counted.length === 1 ? "app" : "apps"} installed
          </Text>
          <Text size="xs" c="dimmed">
            {view.finishedAt ? `finished ${relativeTime(view.finishedAt)}` : `started ${relativeTime(view.createdAt)}`}{" "}
            by {view.startedBy}
          </Text>
        </Group>
        {canCancel ? (
          <Tooltip
            label="Stops the app installing now and the ones after it. Apps already installed stay."
            multiline
            maw={280}
          >
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              leftSection={<IconPlayerStop size={14} />}
              loading={cancelling}
              onClick={() => void cancel()}
            >
              Cancel rollout
            </Button>
          </Tooltip>
        ) : null}
      </Group>
      <Progress
        value={counted.length ? (settled / counted.length) * 100 : 100}
        color={RUN_STATE_COLOR[view.state]}
        size="sm"
        animated={!done}
        aria-label="Rollout progress"
      />
      {cancelError ? (
        <Alert color="red" variant="light" p="xs">
          {cancelError}
        </Alert>
      ) : null}
      <Table verticalSpacing={6} highlightOnHover>
        <Table.Tbody>
          {counted.map((step, index) => {
            const isSelected = selected?.appId === step.appId;
            return (
              <Table.Tr
                key={step.appId}
                data-step={step.appId}
                data-step-state={step.state}
                bg={isSelected ? "var(--mantine-color-default-hover)" : undefined}
              >
                <Table.Td w={28}>
                  <Text size="sm" c="dimmed">
                    {index + 1}.
                  </Text>
                </Table.Td>
                <Table.Td>
                  {step.jobId ? (
                    <UnstyledButton
                      onClick={() => setPicked(step.appId)}
                      aria-label={`Show the log for ${label(step.appId)}`}
                    >
                      <Text size="sm" fw={500}>
                        {label(step.appId)}
                      </Text>
                    </UnstyledButton>
                  ) : (
                    <Text size="sm" fw={500}>
                      {label(step.appId)}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td style={{ minWidth: 112 }}>
                  <Badge color={STEP_STATE_COLOR[step.state]} variant={STEP_STATE_VARIANT[step.state]} radius="xs">
                    {step.state === "pending" ? "waiting" : step.state}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  {step.state === "succeeded" && step.url ? (
                    <Anchor href={step.url} target="_blank" rel="noreferrer" size="sm">
                      <Group gap={4} wrap="nowrap">
                        {step.url}
                        <IconExternalLink size={14} />
                      </Group>
                    </Anchor>
                  ) : step.message ? (
                    <Text size="sm" c={step.state === "failed" ? "red" : "dimmed"} lineClamp={2}>
                      {step.message}
                    </Text>
                  ) : null}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
      <SkippedSteps
        steps={view.steps
          .filter((step) => step.state === "skipped")
          .map((step) => ({
            appId: step.appId,
            name: label(step.appId),
            ...(step.message ? { reason: step.message } : {}),
          }))}
      />
      {selected?.jobId ? (
        <div>
          <Title order={6} mb={4}>
            {label(selected.appId)}
          </Title>
          <DeployJobProgress key={selected.jobId} jobId={selected.jobId} />
        </div>
      ) : null}
    </Stack>
  );
}

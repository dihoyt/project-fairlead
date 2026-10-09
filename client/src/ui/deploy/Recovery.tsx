import { useCallback, useEffect, useState } from "react";
import { Accordion, Alert, Button, Code, Group, List, Loader, Modal, Radio, Stack, Text } from "@mantine/core";
import { IconRefresh, IconTrash } from "@tabler/icons-react";
import type { DeployActionPlan, DeployJobView, PlannedObject } from "@contracts/deploy";
import { apiRequest } from "../api";
import { DeployDialog } from "./DeployDialog";
import { DeployJobProgress } from "./DeployJobProgress";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const describe = (obj: PlannedObject) =>
  obj.kind === "HelmRelease"
    ? `the Helm release ${obj.namespace ? `${obj.namespace}/` : ""}${obj.name}`
    : `${obj.kind} ${obj.namespace ? `${obj.namespace}/` : ""}${obj.name}`;

// Runs a failed install or upgrade again with the values Helm saved from it,
// then shows the new job's log.
export function RetryButton({
  job,
  name,
  disabled,
  onChanged,
}: {
  job: DeployJobView;
  name: string;
  disabled?: boolean;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<DeployJobView | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      setRetry(await apiRequest("POST /api/deploy/jobs/:id/retry", { params: { id: job.id } }));
      onChanged?.();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        size="xs"
        variant="light"
        leftSection={<IconRefresh size={14} />}
        disabled={disabled}
        loading={busy}
        onClick={() => void start()}
      >
        Retry
      </Button>
      <Modal
        opened={retry !== null || error !== null}
        onClose={() => {
          setRetry(null);
          setError(null);
        }}
        title={`Retry ${name}`}
        size="xl"
      >
        {error ? (
          <Alert color="red" variant="light" title="Not retried">
            {error}
          </Alert>
        ) : null}
        {retry ? <DeployJobProgress jobId={retry.id} onFinished={onChanged} /> : null}
      </Modal>
    </>
  );
}

type Choice = "keep" | "delete";

// Uninstall preview and run. Whether the volumes go is asked every time,
// with no default, whenever the app has any.
export function UninstallDialog({
  appId,
  name,
  reinstall,
  onDone,
  onCancel,
}: {
  appId: string;
  name: string;
  // Opens the deploy dialog for a fresh install once the uninstall succeeds.
  reinstall?: boolean;
  onDone: (job: DeployJobView) => void;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState<Choice | null>(null);
  const [plan, setPlan] = useState<DeployActionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<DeployJobView | null>(null);
  const [deploying, setDeploying] = useState(false);
  const deleteVolumes = choice === "delete";

  useEffect(() => {
    let cancelled = false;
    setPlan(null);
    apiRequest("POST /api/deploy/actions/plan", { body: { kind: "remove-app", appId, deleteVolumes } }).then(
      (next) => !cancelled && setPlan(next),
      (err: Error) => !cancelled && setError(err.message)
    );
    return () => {
      cancelled = true;
    };
  }, [appId, deleteVolumes]);

  const run = async () => {
    setStarting(true);
    setError(null);
    try {
      const job = await apiRequest("POST /api/deploy/actions/run", {
        body: { kind: "remove-app", appId, deleteVolumes },
      });
      setJobId(job.id);
    } catch (err) {
      setError(message(err));
    } finally {
      setStarting(false);
    }
  };

  const finished = useCallback(
    (job: DeployJobView) => {
      setResult(job);
      onDone(job);
      if (reinstall && job.state === "succeeded") setDeploying(true);
    },
    [onDone, reinstall]
  );

  if (jobId) {
    return (
      <Stack gap="sm" data-uninstall-phase="run">
        <DeployJobProgress jobId={jobId} onFinished={finished} />
        {result?.state === "succeeded" ? (
          <Alert color="green" variant="light" title={`${name} is uninstalled`}>
            {reinstall ? "Fill in the deploy form to install it again." : null}
          </Alert>
        ) : null}
        {result && result.state !== "succeeded" ? (
          <Alert color="red" variant="light" title="Not uninstalled">
            The log above shows where it stopped.
          </Alert>
        ) : null}
        {reinstall && result?.state === "succeeded" ? (
          <Group justify="flex-end">
            <Button onClick={() => setDeploying(true)}>Deploy {name}</Button>
          </Group>
        ) : null}
        <DeployDialog appId={appId} opened={deploying} onClose={() => setDeploying(false)} />
      </Stack>
    );
  }

  const volumes = plan?.volumes ?? [];
  const needsChoice = volumes.length > 0 && choice === null;
  return (
    <Stack gap="sm" data-uninstall-phase="plan">
      {error ? <Alert color="red">{error}</Alert> : null}
      {!plan && !error ? <Loader size="sm" /> : null}
      {plan && !plan.allowed ? (
        <Alert color="red" variant="light" title={`Can't uninstall ${name}`}>
          {plan.blockedBy}
        </Alert>
      ) : null}
      {plan?.allowed ? (
        <>
          {reinstall ? (
            <Text size="sm">
              Reinstalling uninstalls {name}, then opens the deploy form for a fresh install with new passwords.
            </Text>
          ) : null}
          <Text size="sm">This deletes:</Text>
          <List size="sm" spacing={2} data-deletes>
            {(plan.deletes ?? []).map((obj) => (
              <List.Item key={`${obj.kind}/${obj.namespace ?? ""}/${obj.name}`}>{describe(obj)}</List.Item>
            ))}
          </List>
          {volumes.length > 0 ? (
            <Radio.Group
              value={choice}
              onChange={(value) => setChoice(value as Choice)}
              label={`${volumes.length === 1 ? "Its volume" : "Its volumes"}: ${volumes
                .map((v) => `${v.claim}${v.size ? `, ${v.size}` : ""}`)
                .join("; ")}`}
              withAsterisk
            >
              <Stack gap={6} mt={6}>
                <Radio value="keep" label="Keep the volumes" />
                <Radio value="delete" label="Delete the volumes and their data for good" color="red" />
              </Stack>
            </Radio.Group>
          ) : null}
          {choice !== null || volumes.length === 0
            ? plan.warnings.map((warning) => (
                <Alert key={warning} color={deleteVolumes ? "red" : "yellow"} variant="light" p="xs">
                  {warning}
                </Alert>
              ))
            : null}
          {plan.steps.some((s) => s.commands.length > 0) ? (
            <Accordion variant="contained" chevronPosition="left">
              <Accordion.Item value="steps">
                <Accordion.Control>What it runs</Accordion.Control>
                <Accordion.Panel>
                  <Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                    {plan.steps.flatMap((s) => s.commands).join("\n")}
                  </Code>
                </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
          ) : null}
        </>
      ) : null}
      <Group justify="flex-end">
        <Button variant="default" onClick={onCancel}>
          Cancel
        </Button>
        <Button color="red" onClick={() => void run()} loading={starting} disabled={!plan?.allowed || needsChoice}>
          {reinstall ? `Uninstall and reinstall ${name}` : `Uninstall ${name}`}
        </Button>
      </Group>
    </Stack>
  );
}

export function UninstallButton({
  appId,
  name,
  reinstall,
  disabled,
  onChanged,
}: {
  appId: string;
  name: string;
  reinstall?: boolean;
  disabled?: boolean;
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const done = useCallback(() => onChanged?.(), [onChanged]);
  return (
    <>
      <Button
        size="xs"
        variant="subtle"
        color={reinstall ? undefined : "red"}
        leftSection={reinstall ? <IconRefresh size={14} /> : <IconTrash size={14} />}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {reinstall ? "Reinstall" : "Uninstall"}
      </Button>
      <Modal
        opened={open}
        onClose={() => setOpen(false)}
        title={`${reinstall ? "Reinstall" : "Uninstall"} ${name}`}
        size="lg"
      >
        {open ? (
          <UninstallDialog
            appId={appId}
            name={name}
            reinstall={reinstall}
            onDone={done}
            onCancel={() => setOpen(false)}
          />
        ) : null}
      </Modal>
    </>
  );
}

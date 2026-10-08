import { useCallback, useEffect, useState } from "react";
import { Accordion, Alert, Button, Checkbox, Code, Group, List, Loader, Modal, Stack, Text } from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";
import type { DeployActionPlan, DeployJobView, PlannedObject } from "@contracts/deploy";
import type { TemplateInstance } from "@contracts/templates";
import { apiRequest } from "../../ui/api";
import { DeployJobProgress } from "../../ui/deploy";

const describe = (obj: PlannedObject) =>
  obj.kind === "Check"
    ? `the HTTP check "${obj.name}"`
    : `${obj.kind} ${obj.namespace ? `${obj.namespace}/` : ""}${obj.name}`;

export function RemoveAppButton({
  instance,
  disabled,
  onRemoved,
}: {
  instance: TemplateInstance;
  disabled: boolean;
  onRemoved: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="xs"
        variant="subtle"
        color="red"
        leftSection={<IconTrash size={14} />}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Remove
      </Button>
      <Modal opened={open} onClose={() => setOpen(false)} title={`Remove ${instance.name}`} size="lg">
        {open ? <RemoveDialog instance={instance} onRemoved={onRemoved} onCancel={() => setOpen(false)} /> : null}
      </Modal>
    </>
  );
}

// Preview with the volume kept (the default) or deleted, then the removal as
// one deploy job.
export function RemoveDialog({
  instance,
  onRemoved,
  onCancel,
}: {
  instance: TemplateInstance;
  onRemoved: () => void;
  onCancel: () => void;
}) {
  const [deleteVolumes, setDeleteVolumes] = useState(false);
  const [plan, setPlan] = useState<DeployActionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<DeployJobView | null>(null);
  const appId = instance.name;

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
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const finished = useCallback(
    (job: DeployJobView) => {
      setResult(job);
      onRemoved();
    },
    [onRemoved]
  );

  if (jobId) {
    return (
      <Stack gap="sm" data-remove-phase="run">
        <DeployJobProgress jobId={jobId} onFinished={finished} />
        {result?.state === "succeeded" ? (
          <Alert color="green" variant="light" title={`${instance.name} is removed`}>
            {deleteVolumes
              ? "Its namespace and volumes are gone too."
              : `Its namespace and volumes stay; deploying ${instance.name} again picks the data back up.`}
          </Alert>
        ) : null}
        {result && result.state !== "succeeded" ? (
          <Alert color="red" variant="light" title="Not removed">
            The log above shows where it stopped.
          </Alert>
        ) : null}
      </Stack>
    );
  }

  const volumes = plan?.volumes ?? [];
  return (
    <Stack gap="sm" data-remove-phase="plan">
      {error ? <Alert color="red">{error}</Alert> : null}
      {!plan && !error ? <Loader size="sm" /> : null}
      {plan && !plan.allowed ? (
        <Alert color="red" variant="light" title="Can't remove this app">
          {plan.blockedBy}
        </Alert>
      ) : null}
      {plan?.allowed ? (
        <>
          <Text size="sm">This deletes:</Text>
          <List size="sm" spacing={2} data-deletes>
            {(plan.deletes ?? []).map((obj) => (
              <List.Item key={`${obj.kind}/${obj.namespace ?? ""}/${obj.name}`}>{describe(obj)}</List.Item>
            ))}
          </List>
          {plan.warnings.map((warning) => (
            <Alert key={warning} color={deleteVolumes ? "red" : "yellow"} variant="light" p="xs">
              {warning}
            </Alert>
          ))}
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
      <Checkbox
        checked={deleteVolumes}
        onChange={(event) => setDeleteVolumes(event.currentTarget.checked)}
        label={
          volumes.length > 0
            ? `Delete its ${volumes.length === 1 ? "volume" : "volumes"} too (${volumes.map((v) => `${v.claim}, ${v.size}`).join("; ")})`
            : "Delete its namespace too"
        }
        description={
          volumes.length > 0
            ? "Deletes the namespace and the data in it for good. Left unticked, the data stays for a later deploy."
            : undefined
        }
      />
      <Group justify="flex-end">
        <Button variant="default" onClick={onCancel}>
          Cancel
        </Button>
        <Button color="red" onClick={() => void run()} loading={starting} disabled={!plan?.allowed}>
          {deleteVolumes ? `Remove ${instance.name} and its data` : `Remove ${instance.name}`}
        </Button>
      </Group>
    </Stack>
  );
}

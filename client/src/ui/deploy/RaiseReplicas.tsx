import { useContext, useEffect, useState } from "react";
import { Alert, Button, Checkbox, Code, Group, List, Loader, Modal, Stack, Text, Title } from "@mantine/core";
import type { LonghornReplicaAdvice } from "@contracts/backups";
import type { DeployActionPlan, LonghornReplicasAction } from "@contracts/deploy";
import { apiRequest, useApi } from "../api";
import { SessionContext } from "../session";
import { DeployJobProgress } from "./DeployJobProgress";
import { DeploysOff } from "./DeploysOff";

const POLL_MS = 60_000;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Shown where nodes come and go (the Nodes page, the health board): when
// Longhorn has more schedulable nodes than some volumes have replicas, one
// click raises them. Nothing raises by itself. Renders nothing otherwise.
export function RaiseReplicas() {
  const admin = useContext(SessionContext)?.me.admin === true;
  const advice = useApi("GET /api/longhorn/replicas", undefined, { pollMs: POLL_MS });
  const [open, setOpen] = useState(false);
  const data = advice.data;
  if (!data || data.state !== "raise") return null;

  return (
    <Alert color="yellow" variant="light" title="Longhorn can keep more copies now" data-testid="raise-replicas">
      <Stack gap="xs">
        <Text size="sm">{data.detail} A second replica on another node keeps a volume's data when one node fails.</Text>
        {admin ? (
          <Group>
            <Button size="xs" onClick={() => setOpen(true)}>
              Raise Longhorn replicas to {data.target}
            </Button>
          </Group>
        ) : (
          <Text size="xs" c="dimmed">
            An admin can raise them.
          </Text>
        )}
      </Stack>
      <Modal opened={open} onClose={() => setOpen(false)} title={`Raise Longhorn replicas to ${data.target}`} size="lg">
        {open ? <RaiseDialog advice={data} onDone={advice.reload} /> : null}
      </Modal>
    </Alert>
  );
}

function RaiseDialog({ advice, onDone }: { advice: LonghornReplicaAdvice; onDone: () => void }) {
  const status = useApi("GET /api/deploy/status");
  const [existingVolumes, setExistingVolumes] = useState(true);
  const [plan, setPlan] = useState<DeployActionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const enabled = status.data?.enabled === true;

  const request: LonghornReplicasAction = { kind: "longhorn-replicas", replicas: advice.target, existingVolumes };

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setPlan(null);
    setError(null);
    apiRequest("POST /api/deploy/actions/plan", {
      body: { kind: "longhorn-replicas", replicas: advice.target, existingVolumes },
    }).then(
      (next) => !cancelled && setPlan(next),
      (err: Error) => !cancelled && setError(err.message)
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, existingVolumes, advice.target]);

  if (jobId) return <DeployJobProgress jobId={jobId} onFinished={onDone} />;
  if (status.loading && !status.data) return <Loader size="sm" />;
  if (status.error) return <Alert color="red">{status.error}</Alert>;
  if (status.data && !enabled) return <DeploysOff status={status.data} />;

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      setJobId((await apiRequest("POST /api/deploy/actions/run", { body: request })).id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  return (
    <Stack gap="sm">
      {advice.volumes.length > 0 ? (
        <Checkbox
          checked={existingVolumes}
          onChange={(event) => setExistingVolumes(event.currentTarget.checked)}
          label={`Also raise the ${plural(advice.volumes.length, "existing volume")} below ${advice.target}`}
          description="Each one copies its data to another node, which loads disks and network while it rebuilds."
        />
      ) : null}
      {error ? <Alert color="red">{error}</Alert> : null}
      {!plan && !error ? <Loader size="sm" /> : null}
      {plan ? <ActionPlanView plan={plan} /> : null}
      <Group justify="flex-end">
        <Button onClick={() => void start()} loading={starting} disabled={!plan?.allowed}>
          {plan?.title ?? "Raise"}
        </Button>
      </Group>
    </Stack>
  );
}

function ActionPlanView({ plan }: { plan: DeployActionPlan }) {
  return (
    <Stack gap="sm" data-plan-allowed={plan.allowed}>
      {!plan.allowed && plan.blockedBy ? (
        <Alert color="red" variant="light" title="Can't run this yet">
          {plan.blockedBy}
        </Alert>
      ) : null}
      {plan.warnings.map((warning) => (
        <Alert key={warning} color="yellow" variant="light" p="xs">
          {warning}
        </Alert>
      ))}
      {plan.steps.map((step) => (
        <div key={step.label}>
          <Title order={6} mb={4}>
            {step.label}
          </Title>
          <Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {step.commands.join("\n")}
          </Code>
        </div>
      ))}
      {plan.creates.length > 0 ? (
        <div>
          <Title order={6} mb={4}>
            Runs as
          </Title>
          <List size="sm" spacing={2}>
            {plan.creates.map((obj) => (
              <List.Item key={`${obj.kind}/${obj.namespace ?? ""}/${obj.name}`}>
                {obj.kind} {obj.namespace ? `${obj.namespace}/` : ""}
                {obj.name}
              </List.Item>
            ))}
          </List>
        </div>
      ) : null}
      {plan.rollback ? (
        <Text size="xs" c="dimmed">
          {plan.rollback}
        </Text>
      ) : null}
    </Stack>
  );
}

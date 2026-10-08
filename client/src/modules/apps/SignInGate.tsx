import { useContext, useEffect, useState } from "react";
import { Alert, Badge, Button, Group, Loader, Modal, Stack, Switch, Text, Tooltip } from "@mantine/core";
import type { AppGateState, AppGateView, DeployActionPlan } from "@contracts/deploy";
import { apiRequest } from "../../ui";
import { ActionPlanView, DeployJobProgress } from "../../ui/deploy";
import { SessionContext } from "../../ui/session";

const STATE: Record<AppGateState, { label: string; color: string }> = {
  gated: { label: "Behind sign-in", color: "green" },
  public: { label: "Public", color: "gray" },
  open: { label: "Open to anyone", color: "red" },
  tailnet: { label: "Tailnet only", color: "blue" },
};

export function GateStateBadge({ app }: { app: AppGateView }) {
  return (
    <>
      <Tooltip label={app.reason} disabled={!app.reason} multiline maw={360}>
        <Badge color={STATE[app.state].color} variant="light" radius="xs">
          {STATE[app.state].label}
        </Badge>
      </Tooltip>
      {app.state === "open" && app.reason ? (
        <Text size="xs" c="dimmed" maw={360}>
          {app.reason}
        </Text>
      ) : null}
    </>
  );
}

// The app's Public switch: flipping it previews the app-gate action in a
// dialog and runs it from there.
export function GatePublicSwitch({ app, onChanged }: { app: AppGateView; onChanged?: () => void }) {
  const admin = useContext(SessionContext)?.me.admin ?? true;
  const [makePublic, setMakePublic] = useState<boolean | null>(null);
  return (
    <>
      <Switch
        aria-label={`${app.name} is public`}
        checked={app.public}
        disabled={!admin || app.mode === "public" || app.state === "tailnet"}
        onChange={(event) => setMakePublic(event.currentTarget.checked)}
      />
      <Modal
        opened={makePublic !== null}
        onClose={() => setMakePublic(null)}
        title={makePublic ? `Make ${app.name} public` : `Put ${app.name} behind sign-in`}
        size="lg"
      >
        {makePublic !== null ? (
          <GateDialog appId={app.appId} makePublic={makePublic} onDone={() => onChanged?.()} />
        ) : null}
      </Modal>
    </>
  );
}

function GateDialog({ appId, makePublic, onDone }: { appId: string; makePublic: boolean; onDone: () => void }) {
  const [plan, setPlan] = useState<DeployActionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const request = { kind: "app-gate" as const, appId, public: makePublic };

  useEffect(() => {
    let cancelled = false;
    apiRequest("POST /api/deploy/actions/plan", { body: { kind: "app-gate", appId, public: makePublic } }).then(
      (next) => !cancelled && setPlan(next),
      (err: Error) => !cancelled && setError(err.message)
    );
    return () => {
      cancelled = true;
    };
  }, [appId, makePublic]);

  if (jobId) return <DeployJobProgress jobId={jobId} onFinished={onDone} />;

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
      {error ? <Alert color="red">{error}</Alert> : null}
      {!plan && !error ? <Loader size="sm" /> : null}
      {plan ? <ActionPlanView plan={plan} /> : null}
      <Group justify="flex-end">
        <Button
          onClick={() => void start()}
          loading={starting}
          disabled={!plan?.allowed}
          color={makePublic ? "red" : undefined}
        >
          {plan?.title ?? "Change"}
        </Button>
      </Group>
    </Stack>
  );
}

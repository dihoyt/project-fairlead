import { useContext, useEffect, useState } from "react";
import { Alert, Badge, Button, Group, Loader, Modal, Stack, Switch, Table, Text, Title, Tooltip } from "@mantine/core";
import type { AppGateState, AppGateView, DeployActionPlan } from "@contracts/deploy";
import { apiRequest, useApi } from "../../ui";
import { ActionPlanView, DeployJobProgress } from "../../ui/deploy";
import { SessionContext } from "../../ui/session";

const STATE: Record<AppGateState, { label: string; color: string }> = {
  gated: { label: "Behind sign-in", color: "green" },
  public: { label: "Public", color: "gray" },
  open: { label: "Open to anyone", color: "red" },
  tailnet: { label: "Tailnet only", color: "blue" },
};

// Apps the console deployed sit behind its own sign-in unless made public.
// Each row's switch runs the app-gate action, shown first as a plan.
export function SignInGateSection({ onFinished }: { onFinished?: () => void }) {
  const admin = useContext(SessionContext)?.me.admin ?? true;
  const gate = useApi("GET /api/deploy/gate");
  const [change, setChange] = useState<{ app: AppGateView; public: boolean } | null>(null);
  const data = gate.data;
  if (!data || (data.apps.length === 0 && data.ready)) return null;

  return (
    <section aria-label="Sign-in gate">
      <Title order={4}>Sign-in gate</Title>
      <Text size="sm" c="dimmed" mb="sm">
        Apps deployed from here open only for people signed in to this console, until you make one public. Once sign-in
        goes through Authentik or Entra, so do they.
      </Text>
      {!data.ready && data.reason ? (
        <Alert color="yellow" variant="light" mb="sm" title="The gate can't be put in front of apps">
          {data.reason}
        </Alert>
      ) : null}
      {gate.error ? (
        <Alert color="red" variant="light" mb="sm">
          {gate.error}
        </Alert>
      ) : null}
      {data.apps.length > 0 ? (
        <Table.ScrollContainer minWidth={560}>
          <Table verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>App</Table.Th>
                <Table.Th>Address</Table.Th>
                <Table.Th>State</Table.Th>
                <Table.Th>Public</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.apps.map((app) => (
                <Table.Tr key={app.appId} data-gate-app={app.appId} data-gate-state={app.state}>
                  <Table.Td>{app.name}</Table.Td>
                  <Table.Td>
                    <Text size="sm">{app.hosts.join(", ")}</Text>
                  </Table.Td>
                  <Table.Td>
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
                  </Table.Td>
                  <Table.Td>
                    <Switch
                      aria-label={`${app.name} is public`}
                      checked={app.public}
                      disabled={!admin || app.mode === "public" || app.state === "tailnet"}
                      onChange={(event) => setChange({ app, public: event.currentTarget.checked })}
                    />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : null}
      <Modal
        opened={change !== null}
        onClose={() => setChange(null)}
        title={
          change ? (change.public ? `Make ${change.app.name} public` : `Put ${change.app.name} behind sign-in`) : ""
        }
        size="lg"
      >
        {change ? (
          <GateDialog
            appId={change.app.appId}
            makePublic={change.public}
            onDone={() => {
              gate.reload();
              onFinished?.();
            }}
          />
        ) : null}
      </Modal>
    </section>
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

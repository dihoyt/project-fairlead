import { useContext, useEffect, useState } from "react";
import { Alert, Anchor, Badge, Button, Group, Loader, Modal, Stack, Text, Title } from "@mantine/core";
import { IconPlugConnected } from "@tabler/icons-react";
import type { DeployActionPlan, ForwardedPort, PortsView } from "@contracts/deploy";
import { Link } from "react-router";
import { apiRequest, useApi } from "../../ui";
import { ActionPlanView, DeployJobProgress } from "../../ui/deploy";
import { SessionContext } from "../../ui/session";

export const portLabel = (p: ForwardedPort) => `${p.protocol.toUpperCase()} ${p.port}`;

function PortsDialog({ onDone }: { onDone: () => void }) {
  const [plan, setPlan] = useState<DeployActionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiRequest("POST /api/deploy/actions/plan", { body: { kind: "traefik-ports" } }).then(
      (next) => !cancelled && setPlan(next),
      (err: Error) => !cancelled && setError(err.message)
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (jobId) return <DeployJobProgress jobId={jobId} onFinished={onDone} />;

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      setJobId((await apiRequest("POST /api/deploy/actions/run", { body: { kind: "traefik-ports" } })).id);
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
        <Button onClick={() => void start()} loading={starting} disabled={!plan?.allowed}>
          {plan?.title ?? "Update ports"}
        </Button>
      </Group>
    </Stack>
  );
}

// Previews the traefik-ports action and runs it from there.
export function OpenPortsButton({ label, onDone }: { label?: string; onDone?: () => void }) {
  const admin = useContext(SessionContext)?.me.admin ?? true;
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="xs"
        variant="light"
        leftSection={<IconPlugConnected size={14} />}
        disabled={!admin}
        onClick={() => setOpen(true)}
      >
        {label ?? "Update ports on Traefik"}
      </Button>
      <Modal opened={open} onClose={() => setOpen(false)} title="Forwarded ports on Traefik" size="lg">
        {open ? <PortsDialog onDone={() => onDone?.()} /> : null}
      </Modal>
    </>
  );
}

// The forwarded range, where Traefik's values live, and what is open
// against what external services want.
export function ForwardedPortsPanel({ view, onChanged }: { view: PortsView; onChanged: () => void }) {
  const openKeys = new Set(view.open.map(portLabel));
  const wantedKeys = new Set(view.wanted.map(portLabel));
  const missing = view.wanted.filter((w) => !openKeys.has(portLabel(w)));
  const unused = view.open.filter((p) => !wantedKeys.has(portLabel(p)));
  return (
    <Stack gap="xs" data-testid="forwarded-ports">
      <Title order={5}>Forwarded ports</Title>
      <Text size="sm">
        {view.range ? (
          <>
            Your router forwards <b>{view.range}</b> to the cluster
            {view.address ? (
              <>
                {" "}
                (Traefik answers at <b>{view.address}</b>)
              </>
            ) : null}
            .
          </>
        ) : (
          "No forwarded ports are set yet."
        )}{" "}
        <Anchor component={Link} to="/admin/settings" size="sm">
          Change in Admin &gt; Settings
        </Anchor>
      </Text>
      {view.rangeError ? (
        <Alert color="red" variant="light" p="xs">
          {view.rangeError}
        </Alert>
      ) : null}
      {view.traefikNote ? (
        <Alert color="yellow" variant="light" p="xs">
          {view.traefikNote}
        </Alert>
      ) : view.traefik ? (
        <Text size="xs" c="dimmed">
          {view.traefik.kind === "k3s"
            ? "Traefik is k3s's own; its ports are kept in the HelmChartConfig kube-system/traefik."
            : `Traefik is the one deployed from here (${view.traefik.namespace}/${view.traefik.release}).`}
        </Text>
      ) : null}
      {view.open.length > 0 || view.wanted.length > 0 ? (
        <Group gap={6}>
          {view.wanted.map((w) => (
            <Badge
              key={`${w.appId}:${portLabel(w)}`}
              variant="light"
              radius="xs"
              color={openKeys.has(portLabel(w)) ? "green" : "yellow"}
            >
              {portLabel(w)} → {w.appId}
              {openKeys.has(portLabel(w)) ? "" : " (not open yet)"}
            </Badge>
          ))}
          {unused.map((p) => (
            <Badge key={portLabel(p)} variant="light" radius="xs" color="gray">
              {portLabel(p)} open, unused
            </Badge>
          ))}
        </Group>
      ) : null}
      {view.outOfRange.length > 0 ? (
        <Text size="xs" c="red">
          Outside the range: {view.outOfRange.map((w) => `${portLabel(w)} (${w.appId})`).join(", ")}.
        </Text>
      ) : null}
      {!view.inSync && view.traefik ? (
        <Group>
          <OpenPortsButton
            label={
              missing.length > 0
                ? `Open ${missing.map(portLabel).join(", ")} on Traefik`
                : "Close unused ports on Traefik"
            }
            onDone={onChanged}
          />
        </Group>
      ) : null}
    </Stack>
  );
}

export function usePorts() {
  return useApi("GET /api/deploy/ports");
}

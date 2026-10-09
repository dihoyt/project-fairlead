import { useCallback, useContext, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Loader,
  Menu,
  Modal,
  NumberInput,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { IconChevronDown, IconLock, IconLockOpen, IconPower, IconTruckDelivery } from "@tabler/icons-react";
import type { DeployActionPlan, DeployJobView, DrainPodOutcome, NodeActionRequest } from "@contracts/deploy";
import type { NodeSummary } from "@contracts/metrics";
import { apiRequest, useApi } from "../../ui/api";
import { ActionPlanView, DeployJobProgress, DeploysOff } from "../../ui/deploy";
import { SessionContext } from "../../ui/session";

type Kind = NodeActionRequest["kind"];

const LABEL: Record<Kind, string> = {
  "node-cordon": "Cordon",
  "node-uncordon": "Uncordon",
  "node-drain": "Drain",
  "node-reboot": "Reboot",
};

const DONE: Record<Kind, string> = {
  "node-cordon": "is cordoned",
  "node-uncordon": "takes new pods again",
  "node-drain": "is drained and stays cordoned",
  "node-reboot": "rebooted and takes pods again",
};

const OUTCOME: Record<DrainPodOutcome, { label: string; color: string }> = {
  evict: { label: "moves", color: "blue" },
  skip: { label: "stays", color: "gray" },
  wait: { label: "waits", color: "yellow" },
  block: { label: "blocks", color: "red" },
};

// Cordon, uncordon, drain and reboot for one node, each a deploy action
// previewed before it runs. Admins only; renders nothing for anyone else.
export function NodeActions({ node, onDone }: { node: NodeSummary; onDone?: () => void }) {
  const admin = useContext(SessionContext)?.me.admin === true;
  const [kind, setKind] = useState<Kind | null>(null);
  if (!admin) return null;
  const cordoned = node.schedulable === false;

  return (
    <>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Button
            size="xs"
            variant="default"
            rightSection={<IconChevronDown size={14} />}
            onClick={(event) => event.stopPropagation()}
          >
            Actions
          </Button>
        </Menu.Target>
        <Menu.Dropdown onClick={(event) => event.stopPropagation()}>
          {cordoned ? (
            <Menu.Item leftSection={<IconLockOpen size={14} />} onClick={() => setKind("node-uncordon")}>
              Uncordon
            </Menu.Item>
          ) : (
            <Menu.Item leftSection={<IconLock size={14} />} onClick={() => setKind("node-cordon")}>
              Cordon
            </Menu.Item>
          )}
          <Menu.Item leftSection={<IconTruckDelivery size={14} />} onClick={() => setKind("node-drain")}>
            Drain
          </Menu.Item>
          <Menu.Item leftSection={<IconPower size={14} />} color="red" onClick={() => setKind("node-reboot")}>
            Reboot
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <Modal
        opened={kind !== null}
        onClose={() => setKind(null)}
        title={kind ? `${LABEL[kind]} ${node.name}` : ""}
        size="lg"
      >
        {/* React events cross the portal, so a click here would also reach a clickable row. */}
        <div onClick={(event) => event.stopPropagation()}>
          {kind ? <NodeActionDialog kind={kind} node={node.name} onDone={onDone} /> : null}
        </div>
      </Modal>
    </>
  );
}

export function NodeActionDialog({ kind, node, onDone }: { kind: Kind; node: string; onDone?: () => void }) {
  const status = useApi("GET /api/deploy/status");
  const drains = kind === "node-drain" || kind === "node-reboot";
  const [ignoreDaemonSets, setIgnoreDaemonSets] = useState(true);
  const [deleteEmptyDirData, setDeleteEmptyDirData] = useState(false);
  const [timeoutSeconds, setTimeoutSeconds] = useState(300);
  const [plan, setPlan] = useState<DeployActionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<DeployJobView | null>(null);
  const enabled = status.data?.enabled === true;
  const validTimeout = Number.isInteger(timeoutSeconds) && timeoutSeconds >= 30 && timeoutSeconds <= 3600;

  const request: NodeActionRequest = drains
    ? { kind, node, ignoreDaemonSets, deleteEmptyDirData, timeoutSeconds }
    : { kind, node };
  const body = JSON.stringify(request);

  useEffect(() => {
    if (!enabled || !validTimeout) return;
    let cancelled = false;
    setPlan(null);
    setError(null);
    apiRequest("POST /api/deploy/actions/plan", { body: JSON.parse(body) as NodeActionRequest }).then(
      (next) => !cancelled && setPlan(next),
      (err: Error) => !cancelled && setError(err.message)
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, validTimeout, body]);

  const finished = useCallback(
    (job: DeployJobView) => {
      setResult(job);
      onDone?.();
    },
    [onDone]
  );

  if (jobId) {
    return (
      <Stack gap="sm" data-node-phase="run">
        <DeployJobProgress jobId={jobId} onFinished={finished} />
        {result?.state === "succeeded" ? (
          <Alert color="green" variant="light">
            {node} {DONE[kind]}.
          </Alert>
        ) : null}
        {result && result.state !== "succeeded" ? (
          <Alert color="red" variant="light" title="It stopped">
            The log above shows where. A node left cordoned can be uncordoned from the same menu.
          </Alert>
        ) : null}
      </Stack>
    );
  }
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
    <Stack gap="sm" data-node-phase="plan">
      {drains ? (
        <Stack gap={6}>
          <Checkbox
            checked={ignoreDaemonSets}
            onChange={(event) => setIgnoreDaemonSets(event.currentTarget.checked)}
            label="Leave DaemonSet pods in place"
            description="They run on every node by design; without this the drain refuses them."
          />
          <Checkbox
            checked={deleteEmptyDirData}
            onChange={(event) => setDeleteEmptyDirData(event.currentTarget.checked)}
            label="Evict pods with emptyDir volumes"
            description="Their scratch data is lost; without this such a pod stops the drain."
          />
          <NumberInput
            label="Wait for evictions up to (seconds)"
            description="PodDisruptionBudgets can hold an eviction; the drain fails after this."
            value={timeoutSeconds}
            onChange={(value) => setTimeoutSeconds(typeof value === "number" ? value : Number(value))}
            min={30}
            max={3600}
            step={30}
            w={260}
            error={validTimeout ? undefined : "30 to 3600 seconds"}
          />
        </Stack>
      ) : null}
      {error ? <Alert color="red">{error}</Alert> : null}
      {!plan && !error && validTimeout ? <Loader size="sm" /> : null}
      {plan ? <ActionPlanView plan={plan} /> : null}
      {plan?.pods && plan.pods.length > 0 ? <DrainPods plan={plan} /> : null}
      <Group justify="flex-end">
        <Button
          color={kind === "node-reboot" || kind === "node-drain" ? "red" : undefined}
          onClick={() => void start()}
          loading={starting}
          disabled={!plan?.allowed}
        >
          {plan?.title ?? `${LABEL[kind]} ${node}`}
        </Button>
      </Group>
    </Stack>
  );
}

function DrainPods({ plan }: { plan: DeployActionPlan }) {
  const pods = plan.pods ?? [];
  return (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        Pods on the node
      </Text>
      <Table striped withTableBorder fz="xs" data-drain-pods>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Pod</Table.Th>
            <Table.Th>Owner</Table.Th>
            <Table.Th>Drain</Table.Th>
            <Table.Th>Why</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {pods.map((pod) => (
            <Table.Tr key={`${pod.namespace}/${pod.name}`}>
              <Table.Td>
                {pod.namespace}/{pod.name}
              </Table.Td>
              <Table.Td>{pod.owner ?? "none"}</Table.Td>
              <Table.Td>
                <Badge size="xs" variant="light" color={OUTCOME[pod.outcome].color}>
                  {OUTCOME[pod.outcome].label}
                </Badge>
              </Table.Td>
              <Table.Td>
                {pod.reason ?? ""}
                {pod.pdb ? ` (PodDisruptionBudget ${pod.pdb})` : ""}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

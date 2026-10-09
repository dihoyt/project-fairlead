import { useCallback, useEffect, useState } from "react";
import {
  Accordion,
  Alert,
  Anchor,
  Button,
  Checkbox,
  Code,
  Group,
  List,
  Loader,
  Modal,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { IconDownload } from "@tabler/icons-react";
import type { DeployActionPlan, DeployJobView, VolumeBackupView } from "@contracts/deploy";
import { formatBytes } from "@contracts/disk";
import { apiRequest, pageUrl, useApi } from "../../ui/api";
import { DeployJobProgress, DeploysOff, RaiseReplicas } from "../../ui/deploy";
import { absoluteTime } from "../../ui";

const BACKUP_POLL_MS = 3_000;

type Phase =
  { at: "plan" } | { at: "backup"; jobId: string } | { at: "convert"; jobId: string; result?: DeployJobView };

// The Apps page's way off local-path: preview, an optional download of each
// volume, then the conversion as one deploy job.
export function ConvertToLonghornButton({
  appId,
  name,
  onFinished,
}: {
  appId: string;
  name: string;
  onFinished: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="default" onClick={() => setOpen(true)}>
        Convert to Longhorn
      </Button>
      <Modal opened={open} onClose={() => setOpen(false)} title={`Convert ${name} to Longhorn`} size="xl">
        {open ? <ConvertDialog appId={appId} name={name} onFinished={onFinished} /> : null}
      </Modal>
    </>
  );
}

export function ConvertDialog({ appId, name, onFinished }: { appId: string; name: string; onFinished: () => void }) {
  const status = useApi("GET /api/deploy/status");
  const [plan, setPlan] = useState<DeployActionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backupFirst, setBackupFirst] = useState(true);
  const [starting, setStarting] = useState(false);
  const [phase, setPhase] = useState<Phase>({ at: "plan" });
  const enabled = status.data?.enabled === true;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    apiRequest("POST /api/deploy/actions/plan", { body: { kind: "migrate-to-longhorn", appId } }).then(
      (next) => !cancelled && setPlan(next),
      (err: Error) => !cancelled && setError(err.message)
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, appId]);

  const run = async (kind: "migrate-to-longhorn" | "backup-volumes") => {
    setStarting(true);
    setError(null);
    try {
      const job = await apiRequest("POST /api/deploy/actions/run", { body: { kind, appId } });
      setPhase(kind === "backup-volumes" ? { at: "backup", jobId: job.id } : { at: "convert", jobId: job.id });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const converted = useCallback(
    (job: DeployJobView) => {
      setPhase((p) => (p.at === "convert" ? { ...p, result: job } : p));
      onFinished();
    },
    [onFinished]
  );

  if (status.loading && !status.data) return <Loader size="sm" />;
  if (status.error) return <Alert color="red">{status.error}</Alert>;
  if (status.data && !enabled) return <DeploysOff status={status.data} />;

  if (phase.at === "convert") {
    return (
      <Stack gap="sm" data-convert-phase="convert">
        <DeployJobProgress jobId={phase.jobId} onFinished={converted} />
        {phase.result?.state === "failed" || phase.result?.state === "cancelled" ? (
          <Alert color="red" variant="light" title="Not converted">
            The log above shows where it stopped. Unless it says otherwise, {name} is back on its old local-path volumes
            and nothing was deleted.
          </Alert>
        ) : null}
        {phase.result?.state === "succeeded" ? (
          <Alert color="green" variant="light" title={`${name} is on Longhorn`}>
            Its volumes keep their names; the old local-path volumes were deleted after {name} answered.
          </Alert>
        ) : null}
        {phase.result?.state === "succeeded" && plan?.offerReplicas ? <RaiseReplicas /> : null}
      </Stack>
    );
  }

  return (
    <Stack gap="sm" data-convert-phase={phase.at}>
      {error ? <Alert color="red">{error}</Alert> : null}
      {!plan && !error ? <Loader size="sm" /> : null}
      {plan ? <ConvertPlanView plan={plan} /> : null}
      {phase.at === "backup" ? (
        <BackupDownloads jobId={phase.jobId} name={name} />
      ) : plan?.allowed ? (
        <Checkbox
          checked={backupFirst}
          onChange={(event) => setBackupFirst(event.currentTarget.checked)}
          label="Download a backup first"
          description="A tar.gz of each volume, read while the app keeps running. The conversion keeps the old volume until the app answers either way."
        />
      ) : null}
      <Group justify="flex-end">
        {phase.at === "plan" && backupFirst ? (
          <Button onClick={() => void run("backup-volumes")} loading={starting} disabled={!plan?.allowed}>
            Prepare the backup
          </Button>
        ) : (
          <Button
            color={phase.at === "backup" ? undefined : "orange"}
            onClick={() => void run("migrate-to-longhorn")}
            loading={starting}
            disabled={!plan?.allowed}
          >
            {phase.at === "backup" ? "Continue: convert" : (plan?.title ?? "Convert")}
          </Button>
        )}
      </Group>
    </Stack>
  );
}

function ConvertPlanView({ plan }: { plan: DeployActionPlan }) {
  return (
    <Stack gap="sm" data-plan-allowed={plan.allowed}>
      {!plan.allowed && plan.blockedBy ? (
        <Alert color="red" variant="light" title="Can't convert this app">
          {plan.blockedBy}
        </Alert>
      ) : null}
      {plan.downtime ? (
        <Alert color="orange" variant="light" title="Downtime">
          {plan.downtime}
        </Alert>
      ) : null}
      {(plan.volumes ?? []).length > 0 ? (
        <Table.ScrollContainer minWidth={520}>
          <Table verticalSpacing={4} data-volumes>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Volume</Table.Th>
                <Table.Th>Size</Table.Th>
                <Table.Th>In use</Table.Th>
                <Table.Th>From</Table.Th>
                <Table.Th>To</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {plan.volumes!.map((v) => (
                <Table.Tr key={`${v.namespace}/${v.claim}`}>
                  <Table.Td>
                    {v.namespace}/{v.claim}
                  </Table.Td>
                  <Table.Td>{v.size}</Table.Td>
                  <Table.Td>{v.usedBytes !== undefined ? formatBytes(v.usedBytes) : "unknown"}</Table.Td>
                  <Table.Td>
                    {v.storageClass}
                    {v.node ? ` on ${v.node}` : ""}
                  </Table.Td>
                  <Table.Td>{v.targetStorageClass ?? "longhorn"}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : null}
      {plan.warnings.map((warning) => (
        <Alert key={warning} color="yellow" variant="light" p="xs">
          {warning}
        </Alert>
      ))}
      {plan.rollback ? (
        <Text size="sm" c="dimmed">
          {plan.rollback}
        </Text>
      ) : null}
      {plan.steps.length > 0 ? (
        <Accordion variant="contained" chevronPosition="left">
          <Accordion.Item value="steps">
            <Accordion.Control>What it runs</Accordion.Control>
            <Accordion.Panel>
              <Stack gap="xs">
                {plan.steps.map((step) => (
                  <div key={step.label}>
                    <Text size="sm" fw={600} mb={4}>
                      {step.label}
                    </Text>
                    <Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                      {step.commands.join("\n")}
                    </Code>
                  </div>
                ))}
                {plan.creates.length > 0 ? (
                  <List size="sm" spacing={2}>
                    {plan.creates.map((obj) => (
                      <List.Item key={`${obj.kind}/${obj.namespace ?? ""}/${obj.name}`}>
                        Creates {obj.kind} {obj.namespace ? `${obj.namespace}/` : ""}
                        {obj.name}
                      </List.Item>
                    ))}
                  </List>
                ) : null}
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      ) : null}
    </Stack>
  );
}

function BackupDownloads({ jobId, name }: { jobId: string; name: string }) {
  const [settled, setSettled] = useState(false);
  const backup = useApi(
    "GET /api/deploy/actions/backups/:id",
    { params: { id: jobId } },
    { pollMs: settled ? undefined : BACKUP_POLL_MS }
  );
  const view: VolumeBackupView | null = backup.data;
  useEffect(() => {
    if (view && view.state !== "preparing") setSettled(true);
  }, [view]);

  if (!view || view.state === "preparing") {
    return (
      <Stack gap="xs" data-backup-state="preparing">
        <Text size="sm">Preparing the backup of {name}'s volumes…</Text>
        <DeployJobProgress jobId={jobId} />
      </Stack>
    );
  }
  if (view.state !== "ready") {
    return (
      <Alert color={view.state === "failed" ? "red" : "yellow"} variant="light" data-backup-state={view.state}>
        {view.message ?? `The backup is ${view.state}.`} Converting is still possible.
      </Alert>
    );
  }
  return (
    <Alert color="blue" variant="light" title="Backup ready" data-backup-state="ready">
      <Stack gap={4}>
        {view.files.map((file) => (
          <Anchor key={file.claim} href={pageUrl(file.path)} download={file.filename} size="sm">
            <Group gap={4} wrap="nowrap">
              <IconDownload size={14} />
              {file.filename}
            </Group>
          </Anchor>
        ))}
        <Text size="xs" c="dimmed">
          Each file is made as it downloads, so its size shows only at the end.
          {view.expiresAt ? ` Available until ${absoluteTime(view.expiresAt)}, or until the conversion starts.` : ""}
        </Text>
      </Stack>
    </Alert>
  );
}

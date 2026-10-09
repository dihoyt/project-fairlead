import { useState } from "react";
import { Alert, Badge, Button, Modal, Table, Text, Title } from "@mantine/core";
import type { DeployActionKind, DeployJobView } from "@contracts/deploy";
import { relativeTime, useApi } from "../../ui";
import { DeployJobProgress, JOB_STATE_COLOR, isFinished } from "../../ui/deploy";

const JOBS_POLL_MS = 5_000;

const MODE_LABEL: Record<DeployJobView["mode"] | DeployActionKind, string> = {
  install: "install",
  "dry-run": "dry run",
  upgrade: "upgrade",
  action: "action",
  "longhorn-replicas": "replicas",
  "migrate-to-longhorn": "convert",
  "backup-volumes": "backup",
  "remove-app": "remove",
  "app-gate": "sign-in gate",
  "traefik-ports": "ports",
  "node-cordon": "cordon",
  "node-uncordon": "uncordon",
  "node-drain": "drain",
  "node-reboot": "reboot",
};

function JobsTable({
  jobs,
  names,
  onOpen,
}: {
  jobs: DeployJobView[];
  names: Record<string, string>;
  onOpen: (job: DeployJobView) => void;
}) {
  if (jobs.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        Nothing has been deployed from here yet.
      </Text>
    );
  }
  return (
    <Table.ScrollContainer minWidth={640}>
      <Table verticalSpacing="xs" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>App</Table.Th>
            <Table.Th>State</Table.Th>
            <Table.Th>Release</Table.Th>
            <Table.Th>Started</Table.Th>
            <Table.Th>Result</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {jobs.map((job) => (
            <Table.Tr key={job.id} data-job={job.id}>
              <Table.Td>{names[job.appId] ?? job.appId}</Table.Td>
              <Table.Td>
                <Badge color={JOB_STATE_COLOR[job.state]} variant={isFinished(job.state) ? "light" : "dot"} radius="xs">
                  {job.mode === "install" ? job.state : `${MODE_LABEL[job.action ?? job.mode]} ${job.state}`}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Text size="sm">
                  {job.namespace}/{job.release} {job.version}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm">
                  {relativeTime(job.createdAt)} by {job.startedBy}
                </Text>
              </Table.Td>
              <Table.Td maw={320}>
                <Text size="sm" lineClamp={2} c={job.state === "failed" ? "red" : undefined}>
                  {job.message ?? ""}
                </Text>
              </Table.Td>
              <Table.Td>
                <Button size="compact-xs" variant="subtle" onClick={() => onOpen(job)}>
                  Log
                </Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

// The last deploy jobs of any kind, each with its log.
export function RecentDeploys({ names }: { names: Record<string, string> }) {
  const jobs = useApi("GET /api/deploy/jobs", { query: { limit: "20" } }, { pollMs: JOBS_POLL_MS });
  const [open, setOpen] = useState<DeployJobView | null>(null);
  return (
    <section aria-label="Recent deploys">
      <Title order={4} mb="sm">
        Recent deploys
      </Title>
      {jobs.error ? (
        <Alert color="red" variant="light" mb="sm">
          {jobs.error}
        </Alert>
      ) : null}
      <JobsTable jobs={jobs.data ?? []} names={names} onOpen={setOpen} />
      <Modal
        opened={open !== null}
        onClose={() => setOpen(null)}
        title={open ? `${names[open.appId] ?? open.appId}: ${open.release}` : ""}
        size="xl"
      >
        {open ? <DeployJobProgress jobId={open.id} onFinished={jobs.reload} /> : null}
      </Modal>
    </section>
  );
}

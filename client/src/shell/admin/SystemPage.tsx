import { Alert, Badge, Group, Paper, SimpleGrid, Stack, Table, Text, Title, Tooltip } from "@mantine/core";
import { useApi } from "../../ui/api";
import { absoluteTime, relativeTime } from "../../ui/time";
import { PageHeader } from "../PageHeader";

const seconds = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

// A job whose heartbeat is older than a few of its own intervals means its
// scheduler loop has stopped, which the job's own last result can't show.
function stalled(heartbeatAt: string | undefined, intervalMs: number): boolean {
  return heartbeatAt !== undefined && Date.now() - Date.parse(heartbeatAt) > Math.max(3 * intervalMs, 60_000);
}

export function SystemPage() {
  const modules = useApi("GET /api/system/modules", undefined, { pollMs: 30_000 });
  const jobs = useApi("GET /api/system/jobs", undefined, { pollMs: 10_000 });

  return (
    <>
      <PageHeader title="System" description="Modules loaded by the server and the scheduled jobs they run." />
      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
        <Paper withBorder p="lg">
          <Stack gap="sm">
            <Title order={4}>Modules</Title>
            {modules.error ? <Alert color="red">{modules.error}</Alert> : null}
            <Table fz="sm" verticalSpacing={4}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Module</Table.Th>
                  <Table.Th>Milestone</Table.Th>
                  <Table.Th>Schema</Table.Th>
                  <Table.Th>State</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(modules.data ?? []).map((mod) => (
                  <Table.Tr key={mod.id}>
                    <Table.Td>{mod.id}</Table.Td>
                    <Table.Td>{mod.milestone}</Table.Td>
                    <Table.Td>v{mod.schemaVersion}</Table.Td>
                    <Table.Td>
                      {mod.error ? (
                        <Tooltip label={mod.error} multiline maw={360} withinPortal>
                          <Badge size="xs" color="red" variant="light">
                            failed
                          </Badge>
                        </Tooltip>
                      ) : (
                        <Badge size="xs" color={mod.registered ? "teal" : "gray"} variant="light">
                          {mod.registered ? "registered" : "not registered"}
                        </Badge>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Stack>
        </Paper>
        <Paper withBorder p="lg">
          <Stack gap="sm">
            <Title order={4}>Jobs</Title>
            {jobs.error ? <Alert color="red">{jobs.error}</Alert> : null}
            {jobs.data && jobs.data.length === 0 ? (
              <Text size="sm" c="dimmed">
                No scheduled jobs.
              </Text>
            ) : null}
            <Table fz="sm" verticalSpacing={4}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Job</Table.Th>
                  <Table.Th>Every</Table.Th>
                  <Table.Th>Last run</Table.Th>
                  <Table.Th>Runs / failures</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(jobs.data ?? []).map((job) => (
                  <Table.Tr key={job.name}>
                    <Table.Td>
                      <Text size="sm">{job.name}</Text>
                      <Text size="xs" c="dimmed">
                        {job.module}
                      </Text>
                    </Table.Td>
                    <Table.Td>{seconds(job.intervalMs)}</Table.Td>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        {job.running ? (
                          <Badge size="xs" variant="light">
                            running
                          </Badge>
                        ) : job.lastOk === undefined ? null : (
                          <Badge size="xs" color={job.lastOk ? "teal" : "red"} variant="light">
                            {job.lastOk ? "ok" : "failed"}
                          </Badge>
                        )}
                        {stalled(job.heartbeatAt, job.intervalMs) ? (
                          <Badge size="xs" color="orange" variant="light">
                            stalled
                          </Badge>
                        ) : null}
                        <Text size="xs" c="dimmed" title={job.lastFinishedAt ? absoluteTime(job.lastFinishedAt) : ""}>
                          {relativeTime(job.lastFinishedAt)}
                        </Text>
                      </Group>
                      {job.lastError ? (
                        <Text size="xs" c="red">
                          {job.lastError}
                        </Text>
                      ) : null}
                    </Table.Td>
                    <Table.Td>
                      {job.runs} / {job.failures}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Stack>
        </Paper>
      </SimpleGrid>
    </>
  );
}

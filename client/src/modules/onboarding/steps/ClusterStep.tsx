import { Alert, Badge, Button, Group, Loader, Table, Text } from "@mantine/core";
import { useState } from "react";
import { relativeTime, useApi } from "../../../ui";
import { StepFrame, type StepProps } from "../shared";

export function ClusterStep({ onFinish }: StepProps) {
  const [refresh, setRefresh] = useState<"1" | undefined>(undefined);
  const report = useApi("GET /api/k8s/capabilities", { query: { refresh } });
  const caps = report.data?.capabilities ?? [];
  const missing = caps.filter((c) => c.groupPresent && !c.allowed && !c.optIn);
  const off = caps.filter((c) => c.groupPresent && !c.allowed && c.optIn);
  const notInstalled = caps.filter((c) => !c.groupPresent);
  const unreadable = caps.filter((c) => !c.allowed);
  // With no connection at all every capability reports the same need, which says it once.
  const disconnected = caps.length > 0 && notInstalled.length === caps.length;

  const summary = disconnected
    ? "Not connected to a cluster"
    : [
        `${caps.length - unreadable.length} of ${caps.length} readable`,
        missing.length ? `${missing.length} missing permission` : "",
        off.length ? `${off.length} off by default` : "",
        notInstalled.length ? `${notInstalled.length} not installed` : "",
      ]
        .filter(Boolean)
        .join(", ");

  return (
    <StepFrame
      onFinish={onFinish}
      intro="What the app can read in this cluster. Anything missing here shows up as a gap on the board, not as an error; grant it in the chart's values or the ClusterRole and check again."
      fullPage={{ to: "/admin/system", label: "System page" }}
    >
      {report.loading && !report.data ? <Loader size="sm" /> : null}
      {report.error ? (
        <Alert color="red" title="Cannot reach the cluster">
          {report.error}
        </Alert>
      ) : null}
      {report.data ? (
        <>
          <Group justify="space-between">
            <Text size="sm">
              {summary}. Checked {relativeTime(report.data.checkedAt)}.
            </Text>
            <Button
              size="xs"
              variant="default"
              onClick={() => {
                setRefresh("1");
                report.reload();
              }}
            >
              Check again
            </Button>
          </Group>
          {disconnected ? (
            <Alert color="red">
              Needs {caps[0]?.needs ?? "a Kubernetes connection"}. In a cluster the app uses its ServiceAccount; outside
              one, set KUBECONFIG.
            </Alert>
          ) : unreadable.length ? (
            <Table striped withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Reads</Table.Th>
                  <Table.Th>State</Table.Th>
                  <Table.Th>Needs</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {unreadable.map((cap) => (
                  <Table.Tr key={cap.id}>
                    <Table.Td>{cap.label}</Table.Td>
                    <Table.Td>
                      {!cap.groupPresent ? (
                        <Badge color="gray">not installed</Badge>
                      ) : cap.optIn ? (
                        <Badge color="gray">off by default</Badge>
                      ) : (
                        <Badge color="red">denied</Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {cap.groupPresent && cap.optIn
                          ? `Optional; the chart grants ${cap.needs ?? "it"} only when enabled in its values`
                          : (cap.needs ?? "")}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          ) : null}
        </>
      ) : null}
    </StepFrame>
  );
}

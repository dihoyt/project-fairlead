import { Alert, Badge, Button, Group, Loader, Stack, Table, Text, Title } from "@mantine/core";
import { useState } from "react";
import type { ClusterBasic } from "@contracts/catalog";
import { StatusBadge, relativeTime, useApi } from "../../../ui";
import { DeployButton } from "../../../ui/deploy";
import { DiscoveryNote, useDiscovery, type Discovery } from "../discovery";
import { StepFrame, type StepProps } from "../shared";

// The four things most apps assume a cluster has, each with the catalog apps
// that would fix it when it is missing.
export function ClusterBasics({ discovery }: { discovery: Discovery }) {
  const basics = discovery.report?.basics ?? [];
  if (!basics.length) return <DiscoveryNote discovery={discovery} />;
  const fixes = (basic: ClusterBasic) =>
    basic.status === "ok"
      ? []
      : basic.fixAppIds.flatMap((id) => {
          const app = discovery.app(id);
          return app && app.detected.state !== "installed" ? [app] : [];
        });
  return (
    <Stack gap="xs">
      <Title order={5}>Cluster basics</Title>
      <Table withTableBorder>
        <Table.Tbody>
          {basics.map((basic) => (
            <Table.Tr key={basic.id} data-basic={basic.id}>
              <Table.Td>
                <Text size="sm">{basic.label}</Text>
              </Table.Td>
              <Table.Td>
                <StatusBadge status={basic.status} />
              </Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed">
                  {basic.detail}
                </Text>
              </Table.Td>
              <Table.Td>
                <Group gap="xs" justify="flex-end" wrap="nowrap">
                  {fixes(basic).map((app) => (
                    <DeployButton
                      key={app.id}
                      appId={app.id}
                      label={`Deploy ${app.name}`}
                      size="xs"
                      onDeployed={discovery.refresh}
                    />
                  ))}
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

export function ClusterStep({ onFinish }: StepProps) {
  const [refresh, setRefresh] = useState<"1" | undefined>(undefined);
  const report = useApi("GET /api/k8s/capabilities", { query: { refresh } });
  const discovery = useDiscovery();
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
      what="Kubernetes runs your apps across a few machines. This app watches it through a read-only account and needs a handful of basics in place, like somewhere to keep data and a way in from the network."
      intro="What the app can read in this cluster. Anything missing here shows up as a gap on the board, not as an error; grant it in the chart's values or the ClusterRole and check again."
      fullPage={{ to: "/admin/system", label: "System page" }}
    >
      <ClusterBasics discovery={discovery} />
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
                discovery.refresh();
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

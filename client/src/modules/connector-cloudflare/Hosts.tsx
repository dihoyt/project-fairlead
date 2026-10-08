import { useState } from "react";
import { Alert, Badge, Group, SegmentedControl, Stack, Switch, Table, Text, Tooltip } from "@mantine/core";
import type { CloudflareExposure, CloudflareObjectState, CloudflareView } from "@contracts/connectors";
import { StatusBadge } from "../../ui/StatusBadge";
import { apiRequest } from "../../ui/api";

const STATE: Record<CloudflareObjectState["state"], { label: string; color: string }> = {
  "in-sync": { label: "set up", color: "teal" },
  drifted: { label: "put back", color: "yellow" },
  missing: { label: "recreated", color: "yellow" },
  "conflict-unowned": { label: "not ours", color: "red" },
  pending: { label: "waiting", color: "gray" },
};

function State({ name, state }: { name: string; state?: CloudflareObjectState }) {
  if (!state) return null;
  return (
    <Tooltip label={state.detail} multiline w={320} withArrow>
      <Badge size="xs" variant="light" color={STATE[state.state].color}>
        {name}: {STATE[state.state].label}
      </Badge>
    </Tooltip>
  );
}

export function CloudflareHosts({
  view,
  onChanged,
}: {
  view: CloudflareView;
  onChanged: (next?: CloudflareView) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function change(host: string, body: { exposure?: CloudflareExposure; access?: boolean }) {
    setBusy(host);
    setError(null);
    try {
      await apiRequest("PUT /api/connector-cloudflare/hosts/:host", { params: { host }, body });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (view.hosts.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No apps yet; each one appears here once it is deployed.
      </Text>
    );
  }
  return (
    <Stack gap="xs">
      {error ? <Alert color="red">{error}</Alert> : null}
      <Table fz="sm" verticalSpacing={6} data-cloudflare-hosts>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>App</Table.Th>
            <Table.Th>Exposure</Table.Th>
            {view.accessPolicy === "per-app" ? <Table.Th>Access</Table.Th> : null}
            <Table.Th>In Cloudflare</Table.Th>
            <Table.Th>Status</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {view.hosts.map((h) => (
            <Table.Tr key={h.host} data-host={h.host}>
              <Table.Td>
                <Text size="sm">{h.host}</Text>
              </Table.Td>
              <Table.Td>
                <SegmentedControl
                  size="xs"
                  value={h.exposure}
                  disabled={busy === h.host}
                  onChange={(value) => void change(h.host, { exposure: value as CloudflareExposure })}
                  data={[
                    { value: "tunnel", label: "Tunnel" },
                    { value: "direct", label: "Direct" },
                  ]}
                />
              </Table.Td>
              {view.accessPolicy === "per-app" ? (
                <Table.Td>
                  <Switch
                    size="xs"
                    checked={h.access}
                    disabled={busy === h.host}
                    onChange={(e) => void change(h.host, { access: e.currentTarget.checked })}
                    aria-label={`Cloudflare Access for ${h.host}`}
                  />
                </Table.Td>
              ) : null}
              <Table.Td>
                <Group gap={4}>
                  <State name="DNS" state={h.dns} />
                  <State name="route" state={h.route} />
                  <State name="Access" state={h.accessApp} />
                </Group>
              </Table.Td>
              <Table.Td>
                <Group gap="xs" wrap="nowrap" align="flex-start">
                  <StatusBadge status={h.status} />
                  <Text size="xs">{h.detail}</Text>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

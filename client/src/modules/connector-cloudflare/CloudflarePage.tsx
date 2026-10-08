import { useState } from "react";
import { Alert, Anchor, Button, Group, Paper, Stack, Text, Title } from "@mantine/core";
import type { CloudflareView } from "@contracts/connectors";
import { apiRequest, useApi } from "../../ui/api";
import { relativeTime } from "../../ui/time";
import { PageHeader } from "../../shell/PageHeader";
import { CloudflareConnect } from "./Connect";
import { CloudflareHosts } from "./Hosts";
import { CloudflareTunnel } from "./Tunnel";

const POLICY: Record<CloudflareView["accessPolicy"], string> = {
  never: "Cloudflare Access is off for every app.",
  always: "Every app is behind Cloudflare Access.",
  "per-app": "Cloudflare Access is chosen per app below.",
};

// Everything the Cloudflare connector keeps for this install. Shared with
// the Access step, which shows the same panel once connected.
export function CloudflarePanel({ baseDomain, pollMs }: { baseDomain?: string; pollMs?: number }) {
  const view = useApi("GET /api/connector-cloudflare/view", undefined, pollMs ? { pollMs } : {});
  const access = useApi("GET /api/deploy/access", undefined, pollMs ? { pollMs } : {});
  const cloudflaredInstalled = access.data?.appId === "cloudflared" && access.data.appInstalled === true;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = view.data;

  async function sync() {
    setBusy(true);
    setError(null);
    try {
      await apiRequest("POST /api/connector-cloudflare/sync");
      view.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return view.error ? <Alert color="red">{view.error}</Alert> : null;
  if (!data.connectorId) return <CloudflareConnect baseDomain={baseDomain} onConnected={() => view.reload()} />;
  return (
    <Stack gap="md" data-cloudflare-panel>
      <Group justify="space-between">
        <Text size="sm">
          Zone <b>{data.zone}</b>
          {data.syncedAt ? `, synced ${relativeTime(data.syncedAt)}` : ""}
        </Text>
        <Button size="xs" variant="default" loading={busy} onClick={() => void sync()}>
          Sync now
        </Button>
      </Group>
      {data.error ? <Alert color="yellow">{data.error}</Alert> : null}
      {(data.warnings ?? []).map((warning) => (
        <Alert key={warning} color="yellow" data-cloudflare-warning>
          {warning}
        </Alert>
      ))}
      {error ? <Alert color="red">{error}</Alert> : null}
      <CloudflareTunnel view={data} onChanged={() => view.reload()} cloudflaredInstalled={cloudflaredInstalled} />
      <Text size="xs" c="dimmed">
        {POLICY[data.accessPolicy]} Change it in Admin &gt; Settings.
      </Text>
      <CloudflareHosts view={data} onChanged={() => view.reload()} />
    </Stack>
  );
}

export function CloudflarePage() {
  return (
    <>
      <PageHeader
        title="Cloudflare"
        description="Every app gets its DNS record and tunnel route here, kept in sync as apps come and go. Direct sends an app's traffic straight to your public address instead of through the tunnel."
      />
      <Paper withBorder p="md">
        <Stack gap="sm">
          <Title order={4}>Published apps</Title>
          <CloudflarePanel />
          <Text size="xs" c="dimmed">
            The token and its account live in <Anchor href="#/admin/connectors">Connectors</Anchor>.
          </Text>
        </Stack>
      </Paper>
    </>
  );
}

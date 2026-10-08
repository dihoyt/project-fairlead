import { useState } from "react";
import { Alert, Badge, Button, Group, Stack, Text, TextInput } from "@mantine/core";
import type { CloudflareView } from "@contracts/connectors";
import { apiRequest } from "../../ui/api";

const TUNNEL_COLOR: Record<string, string> = { healthy: "teal", degraded: "yellow", down: "red", inactive: "gray" };

// Creates or adopts the tunnel, then runs cloudflared with its token.
export function CloudflareTunnel({
  view,
  onChanged,
  cloudflaredInstalled,
}: {
  view: CloudflareView;
  onChanged: (next?: CloudflareView) => void;
  cloudflaredInstalled?: boolean;
}) {
  const [adoptId, setAdoptId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deployed, setDeployed] = useState<string | null>(null);

  async function run(what: string, fn: () => Promise<CloudflareView | void>) {
    setBusy(what);
    setError(null);
    try {
      const next = await fn();
      onChanged(next ?? undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!view.tunnel) {
    return (
      <Stack gap="xs" data-cloudflare-tunnel="none">
        <Text size="sm">Apps reach Cloudflare through a tunnel that cloudflared keeps open from this cluster.</Text>
        <Group align="flex-end">
          <Button
            loading={busy === "create"}
            onClick={() => void run("create", () => apiRequest("POST /api/connector-cloudflare/tunnel", { body: {} }))}
          >
            Create a tunnel
          </Button>
          <Text size="sm" c="dimmed">
            or use an existing one:
          </Text>
          <TextInput
            placeholder="Tunnel ID"
            value={adoptId}
            onChange={(e) => setAdoptId(e.currentTarget.value)}
            w={320}
            spellCheck={false}
          />
          <Button
            variant="default"
            disabled={!adoptId.trim()}
            loading={busy === "adopt"}
            onClick={() =>
              void run("adopt", () =>
                apiRequest("POST /api/connector-cloudflare/tunnel", { body: { tunnelId: adoptId.trim() } })
              )
            }
          >
            Use it
          </Button>
        </Group>
        {error ? <Alert color="red">{error}</Alert> : null}
      </Stack>
    );
  }
  const waiting = view.tunnel.status === "inactive" || view.tunnel.status === "down";
  return (
    <Stack gap="xs" data-cloudflare-tunnel={view.tunnel.status}>
      <Group gap="xs">
        <Text size="sm">
          Tunnel <b>{view.tunnel.name}</b>
        </Text>
        <Badge size="sm" variant="light" color={TUNNEL_COLOR[view.tunnel.status] ?? "gray"}>
          {view.tunnel.status}
        </Badge>
      </Group>
      {waiting && !cloudflaredInstalled ? (
        <Group>
          <Text size="sm">No cloudflared is connected to it yet.</Text>
          <Button
            size="xs"
            loading={busy === "deploy"}
            onClick={() =>
              void run("deploy", async () => {
                const job = await apiRequest("POST /api/connector-cloudflare/tunnel/deploy");
                setDeployed(job.id);
              })
            }
          >
            Deploy cloudflared
          </Button>
        </Group>
      ) : null}
      {deployed ? (
        <Text size="sm" c="teal">
          cloudflared is being deployed; follow it on the Apps page.
        </Text>
      ) : null}
      {error ? <Alert color="red">{error}</Alert> : null}
    </Stack>
  );
}

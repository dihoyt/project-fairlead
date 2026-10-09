import { useState } from "react";
import { Alert, Badge, Button, Group, Select, Stack, Text, TextInput } from "@mantine/core";
import type { CloudflareView } from "@contracts/connectors";
import { product } from "../../product";
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
  const [newName, setNewName] = useState("");
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
    const existing = view.existingTunnels ?? [];
    // A reinstall finds the tunnel its last install made, under the same name.
    const ours = existing.find((t) => t.name === product.slug);
    const taken = existing.some((t) => t.name === (newName.trim() || product.slug));
    const adopt = (id: string) =>
      void run(`adopt:${id}`, () => apiRequest("POST /api/connector-cloudflare/tunnel", { body: { tunnelId: id } }));
    const others = existing.filter((t) => t !== ours);
    return (
      <Stack gap="xs" data-cloudflare-tunnel="none">
        <Text size="sm">Apps reach Cloudflare through a tunnel that cloudflared keeps open from this cluster.</Text>
        {ours ? (
          <Group gap="xs" data-tunnel-ours={ours.id}>
            <Button loading={busy === `adopt:${ours.id}`} onClick={() => adopt(ours.id)}>
              Use the existing &quot;{ours.name}&quot; tunnel
            </Button>
            <Text size="xs" c="dimmed">
              Left in your Cloudflare account by an earlier install; its DNS records keep working.
            </Text>
          </Group>
        ) : null}
        <Group align="flex-end" gap="xs">
          <TextInput
            label={ours ? "Or create a new tunnel named" : "Tunnel name"}
            placeholder={product.slug}
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
            w={240}
            spellCheck={false}
            {...(taken ? { error: "Already taken in this account" } : {})}
          />
          <Button
            variant={ours ? "default" : "filled"}
            disabled={taken}
            loading={busy === "create"}
            onClick={() =>
              void run("create", () =>
                apiRequest("POST /api/connector-cloudflare/tunnel", {
                  body: newName.trim() ? { name: newName.trim() } : {},
                })
              )
            }
          >
            Create a tunnel
          </Button>
        </Group>
        {others.length ? (
          <Group align="flex-end" gap="xs">
            <Select
              label="Or use another tunnel in this account"
              placeholder="Pick a tunnel"
              data={others.map((t) => ({ value: t.id, label: `${t.name} (${t.status})` }))}
              value={adoptId || null}
              onChange={(value) => setAdoptId(value ?? "")}
              w={320}
            />
            <Button
              variant="default"
              disabled={!adoptId}
              loading={busy === `adopt:${adoptId}`}
              onClick={() => adopt(adoptId)}
            >
              Use it
            </Button>
          </Group>
        ) : null}
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
      {waiting && cloudflaredInstalled && !deployed ? (
        <Text size="sm" c="yellow" data-cloudflared-elsewhere>
          cloudflared is installed but not connected to this tunnel, so it may be running another tunnel&apos;s token.
          Remove it on the Apps page, then deploy it again here.
        </Text>
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

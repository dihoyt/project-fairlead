import { useState } from "react";
import { Alert, Anchor, Button, Group, List, PasswordInput, Select, Stack, Text } from "@mantine/core";
import type { CloudflareDiscovery, ConnectorView } from "@contracts/connectors";
import { CheckList } from "../../ui/CheckList";
import { apiRequest } from "../../ui/api";

// A token in, a saved Cloudflare connector out: discover what the token
// sees, pick the account and zone, save.
export function CloudflareConnect({
  baseDomain,
  onConnected,
}: {
  baseDomain?: string;
  onConnected: (view: ConnectorView) => void;
}) {
  const [token, setToken] = useState("");
  const [found, setFound] = useState<CloudflareDiscovery | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [zone, setZone] = useState<string | null>(null);
  const [saved, setSaved] = useState<ConnectorView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function discover() {
    setBusy("discover");
    setError(null);
    try {
      const next = await apiRequest("POST /api/connector-cloudflare/discover", { body: { token: token.trim() } });
      setFound(next);
      const match = next.zones.find((z) => baseDomain && (baseDomain === z.name || baseDomain.endsWith(`.${z.name}`)));
      const zoneFor = match ?? next.zones[0];
      setZone(zoneFor?.name ?? null);
      setAccountId(zoneFor?.accountId ?? next.accounts[0]?.id ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function connect() {
    if (!accountId || !zone) return;
    setBusy("connect");
    setError(null);
    try {
      const view = await apiRequest("POST /api/connectors", {
        body: { kind: "cloudflare", name: "Cloudflare", values: { apiToken: token.trim(), accountId, zone } },
      });
      setSaved(view);
      if (view.status !== "crit") onConnected(view);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const zones = (found?.zones ?? []).filter((z) => !accountId || z.accountId === accountId);
  return (
    <Stack gap="sm" data-cloudflare-connect>
      <Text size="sm">
        Create an API token in Cloudflare with these permissions, then paste it here. It is stored encrypted and used
        only to manage what this install publishes.
      </Text>
      <List size="sm">
        <List.Item>Account &gt; Cloudflare Tunnel &gt; Edit</List.Item>
        <List.Item>Zone &gt; DNS &gt; Edit</List.Item>
        <List.Item>Account &gt; Access: Apps and Policies &gt; Edit (only for Cloudflare Access)</List.Item>
      </List>
      <Anchor href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer" size="sm">
        Create a token in Cloudflare
      </Anchor>
      <Group align="flex-end">
        <PasswordInput
          label="API token"
          value={token}
          onChange={(e) => setToken(e.currentTarget.value)}
          autoComplete="off"
          style={{ flex: 1 }}
        />
        <Button
          variant="default"
          disabled={!token.trim()}
          loading={busy === "discover"}
          onClick={() => void discover()}
        >
          Check token
        </Button>
      </Group>
      {found ? (
        <Group align="flex-end">
          <Select
            label="Account"
            data={found.accounts.map((a) => ({ value: a.id, label: a.name }))}
            value={accountId}
            onChange={setAccountId}
            w={260}
          />
          <Select
            label="Zone"
            data={zones.map((z) => ({ value: z.name, label: z.name }))}
            value={zone}
            onChange={setZone}
            w={260}
            nothingFoundMessage="The token sees no zones"
          />
          <Button disabled={!accountId || !zone} loading={busy === "connect"} onClick={() => void connect()}>
            Connect
          </Button>
        </Group>
      ) : null}
      {found && found.zones.length === 0 ? (
        <Alert color="yellow">The token can&apos;t see any zone; give it Zone &gt; DNS &gt; Edit on your domain.</Alert>
      ) : null}
      {saved && saved.status === "crit" ? (
        <Stack gap={4}>
          <Text size="sm" c="red">
            Saved, but not working yet:
          </Text>
          <CheckList results={saved.checks} />
        </Stack>
      ) : null}
      {error ? <Alert color="red">{error}</Alert> : null}
    </Stack>
  );
}

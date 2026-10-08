import { useEffect, useState } from "react";
import { Alert, Button, Group, SegmentedControl, Stack, Text, TextInput } from "@mantine/core";
import type { CloudflareView } from "@contracts/connectors";
import { apiRequest, useApi } from "../../ui/api";

type Policy = CloudflareView["accessPolicy"];

const SETTING = "connector-cloudflare.accessApps";

const POLICY: Record<Policy, string> = {
  never: "No app is behind Cloudflare Access.",
  "per-app": "Choose per app in the list below; apps with no sign-in of their own start with it on.",
  always: "Every app is behind Cloudflare Access.",
};

// The Access mode is a setting and the allow list a connector field; both
// are edited here so Access is set up in one place, then synced at once.
export function CloudflareAccess({ view, onSaved }: { view: CloudflareView; onSaved: () => void }) {
  const connector = useApi("GET /api/connectors/:id", { params: { id: view.connectorId ?? "" } });
  const savedAllow = connector.data?.config.accessEmails ?? "";
  const [policy, setPolicy] = useState<Policy>(view.accessPolicy);
  const [allow, setAllow] = useState(savedAllow);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setPolicy(view.accessPolicy), [view.accessPolicy]);
  useEffect(() => setAllow(savedAllow), [savedAllow]);

  const changed = policy !== view.accessPolicy || allow.trim() !== savedAllow.trim();

  async function save() {
    if (!view.connectorId) return;
    setBusy(true);
    setError(null);
    try {
      if (allow.trim() !== savedAllow.trim()) {
        await apiRequest("PUT /api/connectors/:id", {
          params: { id: view.connectorId },
          body: { values: { accessEmails: allow.trim() } },
        });
      }
      if (policy !== view.accessPolicy) {
        await apiRequest("PUT /api/admin/settings/:key", { params: { key: SETTING }, body: { value: policy } });
      }
      await apiRequest("POST /api/connector-cloudflare/sync");
      connector.reload();
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap="xs" data-cloudflare-access>
      <Text size="sm" fw={500}>
        Cloudflare Access
      </Text>
      <SegmentedControl
        aria-label="Cloudflare Access"
        size="xs"
        w="fit-content"
        value={policy}
        onChange={(v) => setPolicy(v as Policy)}
        data={[
          { value: "never", label: "Off" },
          { value: "per-app", label: "Per app" },
          { value: "always", label: "Every app" },
        ]}
      />
      <Text size="xs" c="dimmed">
        {POLICY[policy]}
      </Text>
      {policy !== "never" ? (
        <TextInput
          label="Who may sign in"
          description="Emails or @domains, comma separated. Cloudflare emails them a one-time code."
          placeholder="you@example.com, @example.com"
          value={allow}
          onChange={(e) => setAllow(e.currentTarget.value)}
          maw={520}
        />
      ) : null}
      {policy !== "never" && !allow.trim() ? (
        <Alert color="yellow" variant="light">
          Add at least one email or @domain; until then no app gets Access.
        </Alert>
      ) : null}
      {error ? <Alert color="red">{error}</Alert> : null}
      <Group>
        <Button size="xs" disabled={!changed} loading={busy} onClick={() => void save()}>
          Save and sync
        </Button>
      </Group>
    </Stack>
  );
}

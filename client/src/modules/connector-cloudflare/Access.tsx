import { useEffect, useState } from "react";
import { Alert, Button, Code, Group, SegmentedControl, Stack, Text, TextInput } from "@mantine/core";
import type { CloudflareView } from "@contracts/connectors";
import { apiRequest, useApi } from "../../ui/api";

type Policy = CloudflareView["accessPolicy"];

const SETTING = "connector-cloudflare.accessApps";

// The console's own sign-in, when it is Google or Microsoft accounts: Access
// can offer the same provider, but only through an OAuth client of its own,
// since Cloudflare's callback is on the team domain, not this console.
const CONSOLE_PROVIDERS: Array<{ issuer: string; name: string; access: string }> = [
  { issuer: "https://accounts.google.com", name: "Google", access: "Google" },
  {
    issuer: "https://login.microsoftonline.com/common/v2.0",
    name: "Microsoft",
    access: "Azure AD, with the directory ID set to common",
  },
];

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
  const overview = useApi("GET /api/admin/overview");
  const settingOf = (key: string) => overview.data?.settings.find((x) => x.key === key)?.value;
  const consoleAllow = (settingOf("auth.oidc.allowedEmails") as string[] | undefined) ?? [];
  const provider = CONSOLE_PROVIDERS.find((p) => p.issuer === settingOf("auth.oidc.issuer"));
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
      {policy !== "never" && !allow.trim() && consoleAllow.length > 0 ? (
        <Group>
          <Button size="xs" variant="default" onClick={() => setAllow(consoleAllow.join(", "))}>
            Use the console&apos;s sign-in list
          </Button>
        </Group>
      ) : null}
      {policy !== "never" && provider ? (
        <Text size="xs" c="dimmed" data-access-provider>
          This console signs in with {provider.name} accounts. Cloudflare Access emails a one-time code by default; to
          offer {provider.name} sign-in there too, add {provider.access} under Zero Trust &gt; Settings &gt;
          Authentication &gt; Login methods. It needs its own OAuth client with the redirect URI{" "}
          <Code>https://&lt;your-team&gt;.cloudflareaccess.com/cdn-cgi/access/callback</Code>; the console&apos;s client
          won&apos;t work there. The list above decides who gets in either way.
        </Text>
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

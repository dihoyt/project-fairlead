import { useState } from "react";
import {
  Alert,
  Anchor,
  Button,
  Checkbox,
  Code,
  Group,
  List,
  Loader,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import type { PocketIdWireResult } from "@contracts/auth";
import { apiRequest, useApi } from "../../../ui";
import { useAction } from "../shared";

// Passkeys are bound to an https origin, so Pocket ID itself refuses to
// sign anyone in over plain http, localhost aside.
function needsHttps(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1";
  } catch {
    return false;
  }
}

export function PocketIdWire({
  publicUrl,
  apiUrl,
  onWired,
  onOpenAccess,
}: {
  publicUrl: string;
  apiUrl?: string;
  onWired: (result: PocketIdWireResult) => void;
  onOpenAccess?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [keepKey, setKeepKey] = useState(false);
  const [adminGroup, setAdminGroup] = useState("");
  const [result, setResult] = useState<PocketIdWireResult>();
  const plan = useApi(
    "GET /api/admin/oidc/pocket-id",
    { query: { url: publicUrl, ...(apiUrl ? { apiUrl } : {}) } },
    { enabled: open }
  );
  const wire = useAction();
  const insecure = needsHttps(publicUrl);

  async function run() {
    const group = adminGroup.trim();
    const wired = await wire.run(() =>
      apiRequest("POST /api/admin/oidc/pocket-id", {
        body: {
          pocketIdUrl: publicUrl,
          ...(apiUrl ? { apiUrl } : {}),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          keepKey,
          ...(group ? { adminGroups: [group] } : {}),
        },
      })
    );
    if (wired) {
      setApiKey("");
      setResult(wired);
      plan.reload();
      onWired(wired);
    }
  }

  const httpsNote = insecure ? (
    <Alert color="yellow" data-pocket-id-https>
      <Stack gap={6}>
        <Text size="sm">
          Pocket ID signs people in with passkeys, which work only over https, and {publicUrl} is plain http. Give it an
          https address first.
        </Text>
        {onOpenAccess ? (
          <Group>
            <Button size="xs" variant="light" onClick={onOpenAccess}>
              Set up https on the Access step
            </Button>
          </Group>
        ) : null}
      </Stack>
    </Alert>
  ) : null;

  if (result) {
    return (
      <Stack gap="xs" data-pocket-id-wired>
        <Alert color={result.discovery.ok ? "green" : "yellow"} title="Pocket ID is wired up">
          <Stack gap={4}>
            <Text size="sm">
              Client <Code>{result.clientId}</Code>{" "}
              {result.client === "created" ? "created" : result.client === "updated" ? "updated" : "found"} with a new
              secret; issuer <Code>{result.issuer}</Code>.
            </Text>
            {result.discovery.ok ? (
              <Anchor href={new URL(result.testSignIn, document.baseURI).href} size="sm">
                Test sign-in
              </Anchor>
            ) : (
              <Text size="sm">Sign-in can&apos;t reach it yet: {result.discovery.error}</Text>
            )}
            <Text size="xs" c="dimmed">
              Test sign-in signs you in through Pocket ID once and links that login to this account.
            </Text>
          </Stack>
        </Alert>
        {httpsNote}
      </Stack>
    );
  }

  if (!open) {
    return (
      <Group gap="xs">
        <Button size="xs" onClick={() => setOpen(true)}>
          Wire up Pocket ID
        </Button>
        <Text size="xs" c="dimmed">
          Creates the sign-in client in Pocket ID and fills in the fields below.
        </Text>
      </Group>
    );
  }

  const p = plan.data;
  return (
    <Paper withBorder p="sm" data-pocket-id-wire>
      <Stack gap="xs">
        {plan.loading && !p ? <Loader size="sm" /> : null}
        {plan.error ? <Alert color="red">{plan.error}</Alert> : null}
        {p ? (
          <>
            <Text size="sm" fw={500}>
              This creates, in Pocket ID at {p.pocketIdUrl}:
            </Text>
            <List size="sm" spacing={2}>
              <List.Item>
                an OIDC client named {p.clientName} (client ID <Code>{p.clientId}</Code>) and a client secret for it
              </List.Item>
              <List.Item>
                with callback URL <Code>{p.redirectUri || "(no public URL yet)"}</Code>
              </List.Item>
              <List.Item>
                and saves issuer <Code>{p.issuer}</Code>, the client ID and secret here
              </List.Item>
            </List>
            <Text size="xs" c="dimmed">
              Running it again finds the same client and adds a fresh secret; remove older ones in Pocket ID.
            </Text>
            {p.blocked ? <Alert color="yellow">{p.blocked}</Alert> : null}
          </>
        ) : null}
        {httpsNote}
        <PasswordInput
          label="Pocket ID API key"
          description={
            p?.hasStoredKey
              ? "A key is kept from an earlier run; leave empty to use it."
              : "Sign in to Pocket ID as an admin, then Settings > Admin > API Keys > Add API Key. Used for this run only unless you tick below."
          }
          value={apiKey}
          onChange={(e) => setApiKey(e.currentTarget.value)}
        />
        <Checkbox
          label="Keep the key for later changes"
          checked={keepKey}
          onChange={(e) => setKeepKey(e.currentTarget.checked)}
        />
        <TextInput
          label="Admin group (optional)"
          description="Members of this Pocket ID group are admins here."
          value={adminGroup}
          onChange={(e) => setAdminGroup(e.currentTarget.value)}
        />
        {wire.error ? <Alert color="red">{wire.error}</Alert> : null}
        <Group gap="xs">
          <Button
            size="xs"
            loading={wire.busy}
            disabled={!p || p.blocked !== null || (!apiKey.trim() && !p.hasStoredKey)}
            onClick={() => void run()}
          >
            Create in Pocket ID
          </Button>
          <Button size="xs" variant="subtle" color="gray" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

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
} from "@mantine/core";
import type { AuthentikWireResult } from "@contracts/auth";
import type { CatalogAppView, IngressHost } from "@contracts/catalog";
import { apiRequest, useApi } from "../../../ui";
import { useAction } from "../shared";

const ADMIN_GROUP = "authentik Admins";

const isLocal = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

// Sign-in redirects the browser to the issuer and this server fetches its
// discovery and tokens, both of which the OIDC client allows only over https.
function needsHttps(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && !isLocal(parsed.hostname);
  } catch {
    return false;
  }
}

// Where browsers reach Authentik and where this server calls its API: the
// Ingress host (https first) and the Service behind it, so the API token never
// leaves the cluster even when the Ingress has no TLS.
export function authentikAddresses(
  app: CatalogAppView,
  hosts: IngressHost[] | undefined
): { publicUrl: string; apiUrl?: string } | null {
  const own = (hosts ?? []).filter((h) => h.appId === app.id);
  const host = own.find((h) => h.tls) ?? own[0];
  const publicUrl = (host?.url ?? app.detected.urls[0] ?? "").replace(/\/+$/, "");
  if (!publicUrl) return null;
  return { publicUrl, ...(host?.serviceUrl ? { apiUrl: host.serviceUrl } : {}) };
}

export function AuthentikWire({
  publicUrl,
  apiUrl,
  onWired,
  onOpenAccess,
}: {
  publicUrl: string;
  apiUrl?: string;
  onWired: (result: AuthentikWireResult) => void;
  onOpenAccess?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [keepToken, setKeepToken] = useState(false);
  const [admins, setAdmins] = useState(true);
  const [result, setResult] = useState<AuthentikWireResult>();
  const plan = useApi(
    "GET /api/admin/oidc/authentik",
    { query: { url: publicUrl, ...(apiUrl ? { apiUrl } : {}) } },
    { enabled: open }
  );
  const wire = useAction();
  const insecure = needsHttps(publicUrl);

  async function run() {
    const wired = await wire.run(() =>
      apiRequest("POST /api/admin/oidc/authentik", {
        body: {
          authentikUrl: publicUrl,
          ...(apiUrl ? { apiUrl } : {}),
          ...(token.trim() ? { token: token.trim() } : {}),
          keepToken,
          ...(admins ? { adminGroups: [ADMIN_GROUP] } : {}),
        },
      })
    );
    if (wired) {
      setToken("");
      setResult(wired);
      plan.reload();
      onWired(wired);
    }
  }

  const httpsNote = insecure ? (
    <Alert color="yellow" data-authentik-https>
      <Stack gap={6}>
        <Text size="sm">
          Sign-in needs Authentik on https, and {publicUrl} is plain http. Wiring still works, but the sign-in button
          stays off until Authentik has an https address.
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
      <Stack gap="xs" data-authentik-wired>
        <Alert color={result.discovery.ok ? "green" : "yellow"} title="Authentik is wired up">
          <Stack gap={4}>
            <Text size="sm">
              Application <Code>{result.slug}</Code> {result.application === "created" ? "created" : "found"}; provider{" "}
              {result.provider === "unchanged" ? "already set up" : result.provider}. Client ID{" "}
              <Code>{result.clientId}</Code>, issuer <Code>{result.issuer}</Code>.
            </Text>
            {result.discovery.ok ? null : (
              <Text size="sm">Sign-in can&apos;t reach it yet: {result.discovery.error}</Text>
            )}
            {result.discovery.ok ? (
              <Anchor href={new URL(result.testSignIn, document.baseURI).href} size="sm">
                Test sign-in
              </Anchor>
            ) : null}
            <Text size="xs" c="dimmed">
              Test sign-in signs you in through Authentik once and links that login to this account.
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
          Wire up Authentik
        </Button>
        <Text size="xs" c="dimmed">
          Creates the sign-in app in Authentik and fills in the fields below.
        </Text>
      </Group>
    );
  }

  const p = plan.data;
  return (
    <Paper withBorder p="sm" data-authentik-wire>
      <Stack gap="xs">
        {plan.loading && !p ? <Loader size="sm" /> : null}
        {plan.error ? <Alert color="red">{plan.error}</Alert> : null}
        {p ? (
          <>
            <Text size="sm" fw={500}>
              This creates, in Authentik at {p.authentikUrl}:
            </Text>
            <List size="sm" spacing={2}>
              <List.Item>
                an OAuth2/OpenID provider and an application named {p.applicationName} (slug <Code>{p.slug}</Code>)
              </List.Item>
              <List.Item>
                with redirect URI <Code>{p.redirectUri || "(no public URL yet)"}</Code>
              </List.Item>
              <List.Item>
                and saves issuer <Code>{p.issuer}</Code>, the client ID and secret here
              </List.Item>
            </List>
            <Text size="xs" c="dimmed">
              Running it again finds the same application and changes nothing that is already right.
            </Text>
            {p.blocked ? <Alert color="yellow">{p.blocked}</Alert> : null}
          </>
        ) : null}
        {httpsNote}
        <PasswordInput
          label="Authentik API token"
          description={
            p?.hasStoredToken
              ? "A token is kept from an earlier run; leave empty to use it."
              : "The bootstrap token, or an admin's token from Directory > Tokens and App passwords in Authentik. Used for this run only unless you tick below."
          }
          value={token}
          onChange={(e) => setToken(e.currentTarget.value)}
        />
        <Checkbox
          label="Keep the token for later changes"
          checked={keepToken}
          onChange={(e) => setKeepToken(e.currentTarget.checked)}
        />
        <Checkbox
          label={`Members of "${ADMIN_GROUP}" are admins here`}
          checked={admins}
          onChange={(e) => setAdmins(e.currentTarget.checked)}
        />
        {wire.error ? <Alert color="red">{wire.error}</Alert> : null}
        <Group gap="xs">
          <Button
            size="xs"
            loading={wire.busy}
            disabled={!p || p.blocked !== null || (!token.trim() && !p.hasStoredToken)}
            onClick={() => void run()}
          >
            Create in Authentik
          </Button>
          <Button size="xs" variant="subtle" color="gray" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

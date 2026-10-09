import { useState, type ReactNode } from "react";
import {
  Alert,
  Anchor,
  Button,
  Code,
  CopyButton,
  Group,
  List,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import type { PublicSignInProvider, PublicSignInResult } from "@contracts/auth";
import { apiRequest } from "../../../ui";
import { useAction } from "../shared";

export const PUBLIC_ISSUERS: Record<PublicSignInProvider, string> = {
  google: "https://accounts.google.com",
  microsoft: "https://login.microsoftonline.com/common/v2.0",
};

const NAMES: Record<PublicSignInProvider, string> = { google: "Google", microsoft: "Microsoft" };

function steps(provider: PublicSignInProvider, redirect: ReactNode): ReactNode[] {
  if (provider === "google") {
    return [
      <>
        In{" "}
        <Anchor href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
          Google Cloud Console, APIs &amp; Services, Credentials
        </Anchor>
        , pick or create a project. If asked, set up the <b>OAuth consent screen</b> with user type <b>External</b>.
      </>,
      <>
        Choose <b>Create credentials</b>, <b>OAuth client ID</b>, type <b>Web application</b>, and add {redirect} under{" "}
        <b>Authorized redirect URIs</b>.
      </>,
      <>
        Copy the <b>Client ID</b> and <b>Client secret</b> into the fields below.
      </>,
      <>
        While the consent screen is in <b>Testing</b>, only its listed test users can sign in; publish it to let in
        anyone on your allowed list below.
      </>,
    ];
  }
  return [
    <>
      In the{" "}
      <Anchor
        href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
        target="_blank"
        rel="noreferrer"
      >
        Entra admin center, App registrations
      </Anchor>
      , choose <b>New registration</b>. Any Microsoft account can make one; nobody needs to be invited to your tenant.
    </>,
    <>
      Under supported account types pick <b>Accounts in any organizational directory and personal Microsoft accounts</b>
      . Set the redirect URI platform to <b>Web</b> and enter {redirect}.
    </>,
    <>
      Copy the <b>Application (client) ID</b> from <b>Overview</b>, then under <b>Certificates &amp; secrets</b> add a
      client secret and paste its <b>Value</b> (not the Secret ID).
    </>,
    <>
      Optional, for work and school accounts: under <b>Token configuration</b> add the optional ID claim <b>xms_edov</b>
      . Without it only personal Microsoft accounts count as having a verified email, because a work account&apos;s
      email is whatever its own tenant&apos;s admin typed.
    </>,
  ];
}

const entries = (text: string) =>
  text
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter(Boolean);

// Google and Microsoft redirect only to https, apart from localhost.
const httpRedirect = (uri: string) => {
  try {
    const url = new URL(uri);
    return url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
};

function PresetForm({
  provider,
  redirectUri,
  stored,
  onSaved,
  onCancel,
  onOpenAccess,
}: {
  provider: PublicSignInProvider;
  redirectUri: string;
  stored: { clientId: string; hasSecret: boolean; allowedEmails: string[]; adminEmails: string[] };
  onSaved: (result: PublicSignInResult) => void;
  onCancel: () => void;
  onOpenAccess?: () => void;
}) {
  const [clientId, setClientId] = useState(stored.clientId);
  const [secret, setSecret] = useState("");
  const [allowed, setAllowed] = useState(stored.allowedEmails.join("\n"));
  const [admins, setAdmins] = useState(stored.adminEmails.join("\n"));
  const save = useAction();
  const keepsSecret = stored.hasSecret && stored.clientId !== "" && stored.clientId === clientId.trim();
  const allowedList = entries(allowed);

  const redirect = (
    <Group gap={4} component="span" display="inline-flex">
      <Code>{redirectUri}</Code>
      <CopyButton value={redirectUri}>
        {({ copied, copy }) => (
          <Button size="compact-xs" variant="subtle" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </Button>
        )}
      </CopyButton>
    </Group>
  );

  async function submit() {
    const result = await save.run(() =>
      apiRequest("POST /api/admin/oidc/public", {
        body: {
          provider,
          clientId: clientId.trim(),
          ...(secret ? { clientSecret: secret } : {}),
          allowedEmails: allowedList,
          adminEmails: entries(admins),
        },
      })
    );
    if (result) onSaved(result);
  }

  return (
    <Paper withBorder p="sm" data-public-preset={provider}>
      <Stack gap="sm">
        <Text size="sm" fw={500}>
          Sign in with {NAMES[provider]}
        </Text>
        {httpRedirect(redirectUri) ? (
          <Alert color="yellow" data-public-http>
            <Stack gap={6}>
              <Text size="sm">
                {NAMES[provider]} only sends people back to an https address (or localhost), and this console is at{" "}
                <Code>{new URL(redirectUri).origin}</Code>.
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
        ) : null}
        <List type="ordered" size="sm" spacing={4}>
          {steps(provider, redirect).map((step, i) => (
            <List.Item key={i}>{step}</List.Item>
          ))}
        </List>
        <TextInput label="Client ID" value={clientId} onChange={(e) => setClientId(e.currentTarget.value)} />
        <PasswordInput
          label="Client secret"
          description={keepsSecret ? "A secret is stored for this client; leave empty to keep it." : undefined}
          value={secret}
          onChange={(e) => setSecret(e.currentTarget.value)}
        />
        <Textarea
          label="Who may sign in"
          withAsterisk
          description={`Anyone can have a ${NAMES[provider]} account, so only these verified addresses or domains get in. One per line: ann@example.com, or @example.com for a whole domain.`}
          placeholder={"ann@example.com\n@example.com"}
          minRows={2}
          value={allowed}
          onChange={(e) => setAllowed(e.currentTarget.value)}
          error={allowed.trim() === "" ? "Required" : undefined}
          data-allowed-emails
        />
        <Textarea
          label="Admins"
          description="Signing in with one of these addresses makes the account an admin. Others get read access."
          placeholder="ann@example.com"
          minRows={1}
          value={admins}
          onChange={(e) => setAdmins(e.currentTarget.value)}
        />
        {save.error ? <Alert color="red">{save.error}</Alert> : null}
        <Group>
          <Button
            loading={save.busy}
            disabled={!clientId.trim() || (!secret && !keepsSecret) || allowedList.length === 0}
            onClick={submit}
          >
            Save {NAMES[provider]} sign-in
          </Button>
          <Button variant="subtle" onClick={onCancel}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

// Personal (or any) Google and Microsoft accounts: one OAuth client, no
// tenant to invite anyone to; the allow list decides who gets in.
export function PublicSignIn({
  redirectUri,
  current,
  onSaved,
  onOpenAccess,
}: {
  redirectUri: string;
  current: { issuer: string; clientId: string; hasSecret: boolean; allowedEmails: string[]; adminEmails: string[] };
  onSaved: (result: PublicSignInResult) => void;
  onOpenAccess?: () => void;
}) {
  const [open, setOpen] = useState<PublicSignInProvider | null>(null);
  const [saved, setSaved] = useState<PublicSignInResult | null>(null);
  const active = (Object.keys(PUBLIC_ISSUERS) as PublicSignInProvider[]).find(
    (p) => PUBLIC_ISSUERS[p] === current.issuer.replace(/\/+$/, "")
  );

  if (open) {
    const same = active === open;
    return (
      <PresetForm
        provider={open}
        redirectUri={redirectUri}
        stored={{
          clientId: same ? current.clientId : "",
          hasSecret: same && current.hasSecret,
          allowedEmails: current.allowedEmails,
          adminEmails: current.adminEmails,
        }}
        onCancel={() => setOpen(null)}
        onSaved={(result) => {
          setOpen(null);
          setSaved(result);
          onSaved(result);
        }}
        onOpenAccess={onOpenAccess}
      />
    );
  }

  return (
    <Stack gap="xs" data-public-sign-in>
      <Group gap="xs">
        <Text size="sm">Personal or work accounts, no tenant invites:</Text>
        <Button size="xs" variant="light" onClick={() => setOpen("google")}>
          {active === "google" ? "Change Google sign-in" : "Google"}
        </Button>
        <Button size="xs" variant="light" onClick={() => setOpen("microsoft")}>
          {active === "microsoft" ? "Change Microsoft sign-in" : "Microsoft"}
        </Button>
      </Group>
      {active ? (
        <Text size="xs" c="dimmed">
          Signing in with {NAMES[active]}; allowed: {current.allowedEmails.join(", ") || "nobody yet"}.
        </Text>
      ) : null}
      {saved && !saved.discovery.ok ? (
        <Alert color="red" title="Saved, but the provider could not be reached">
          {saved.discovery.error}
        </Alert>
      ) : null}
      {saved?.discovery.ok ? (
        <Alert color="green" title={`${NAMES[saved.provider]} sign-in saved`}>
          <Text size="sm">
            Sign out and use <b>Sign in with {NAMES[saved.provider]}</b>, or{" "}
            <Anchor href="auth/oidc/start?link=1">link your {NAMES[saved.provider]} account</Anchor> to this one now.
          </Text>
        </Alert>
      ) : null}
    </Stack>
  );
}

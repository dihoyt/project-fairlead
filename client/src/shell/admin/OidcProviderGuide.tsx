import { useState, type ReactNode } from "react";
import { Button, Code, CopyButton, Group, List, Paper, SegmentedControl, Stack, Text } from "@mantine/core";

export type OidcProviderId = "entra" | "authentik" | "keycloak" | "google";

interface Provider {
  id: OidcProviderId;
  name: string;
  issuer: string;
  steps: (redirect: ReactNode) => ReactNode[];
}

const PROVIDERS: Provider[] = [
  {
    id: "entra",
    name: "Entra ID",
    issuer: "https://login.microsoftonline.com/<tenant-id>/v2.0",
    steps: (redirect) => [
      <>
        In the Entra admin center, open <b>App registrations</b> and choose <b>New registration</b>. Pick{" "}
        <b>Single tenant</b>, set the redirect URI platform to <b>Web</b> and enter {redirect}. Entra only accepts http
        for localhost, so the public URL must be https.
      </>,
      <>
        From the app&apos;s <b>Overview</b>, copy the <b>Application (client) ID</b> into <b>Client ID</b>, and put the{" "}
        <b>Directory (tenant) ID</b> into the issuer pattern below for <b>Issuer URL</b>.
      </>,
      <>
        Under <b>Certificates &amp; secrets</b>, add a client secret and paste its <b>Value</b> (not the Secret ID) into{" "}
        <b>Client secret</b>.
      </>,
      <>
        For admin groups, open <b>Token configuration</b>, add a <b>groups claim</b> for security groups, and list each
        group&apos;s <b>Object ID</b> under <b>Admin groups</b>: Entra sends IDs, not names.
      </>,
    ],
  },
  {
    id: "authentik",
    name: "Authentik",
    issuer: "https://authentik.example.com/application/o/<app-slug>/",
    steps: (redirect) => [
      <>
        Under <b>Applications</b>, choose <b>Create with provider</b> (or create an <b>OAuth2/OpenID Provider</b> and an
        application separately). Note the application&apos;s <b>slug</b>.
      </>,
      <>
        Set the client type to <b>Confidential</b>, add {redirect} as a strict redirect URI, and pick a{" "}
        <b>signing key</b> so tokens are signed with RS256.
      </>,
      <>
        Copy the provider&apos;s <b>Client ID</b> and <b>Client Secret</b> into the fields of the same names. The{" "}
        <b>Issuer URL</b> is the pattern below with your host and slug; the provider page shows it as{" "}
        <b>OpenID Configuration Issuer</b>.
      </>,
      <>
        The default <b>profile</b> scope already sends a <b>groups</b> claim with group names, so list the names under{" "}
        <b>Admin groups</b>.
      </>,
    ],
  },
  {
    id: "keycloak",
    name: "Keycloak",
    issuer: "https://keycloak.example.com/realms/<realm>",
    steps: (redirect) => [
      <>
        In your realm, open <b>Clients</b> and choose <b>Create client</b> with type <b>OpenID Connect</b>. Turn on{" "}
        <b>Client authentication</b> and keep <b>Standard flow</b> on.
      </>,
      <>
        Add {redirect} under <b>Valid redirect URIs</b> and the public URL under <b>Web origins</b>.
      </>,
      <>
        Paste the client&apos;s ID into <b>Client ID</b> and the secret from its <b>Credentials</b> tab into{" "}
        <b>Client secret</b>. The <b>Issuer URL</b> is the pattern below with your host and realm.
      </>,
      <>
        For admin groups, open the client&apos;s dedicated scope, add a <b>Group Membership</b> mapper with token claim
        name <b>groups</b> and <b>Full group path</b> off, then list the group names under <b>Admin groups</b>.
      </>,
    ],
  },
  {
    id: "google",
    name: "Google",
    issuer: "https://accounts.google.com",
    steps: (redirect) => [
      <>
        In the Google Cloud console, configure the <b>OAuth consent screen</b> (Internal for a Workspace org), then
        under <b>Credentials</b> create an <b>OAuth client ID</b> of type <b>Web application</b>.
      </>,
      <>
        Add {redirect} under <b>Authorized redirect URIs</b>.
      </>,
      <>
        Copy the <b>Client ID</b> and <b>Client secret</b> into the fields of the same names; the <b>Issuer URL</b> is
        the one below as is.
      </>,
      <>
        Google sends no username or groups claim: set <b>Username claim</b> to <b>email</b> on the sign-in settings
        page, and make admins by role under <b>Users</b> instead of by group.
      </>,
    ],
  },
];

function Copyable({ value }: { value: string }) {
  return (
    <Group gap={4} component="span" wrap="nowrap" style={{ display: "inline-flex", verticalAlign: "middle" }}>
      <Code>{value}</Code>
      <CopyButton value={value}>
        {({ copied, copy }) => (
          <Button size="compact-xs" variant="subtle" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </Button>
        )}
      </CopyButton>
    </Group>
  );
}

export function OidcProviderGuide({ redirectUri }: { redirectUri: string }) {
  const [id, setId] = useState<OidcProviderId>("entra");
  const provider = PROVIDERS.find((p) => p.id === id)!;
  const redirect = redirectUri ? <Copyable value={redirectUri} /> : <b>the redirect URI</b>;
  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Text size="sm" fw={500}>
          Setting up a provider
        </Text>
        <SegmentedControl
          size="xs"
          value={id}
          onChange={(value) => setId(value as OidcProviderId)}
          data={PROVIDERS.map((p) => ({ value: p.id, label: p.name }))}
        />
        <List type="ordered" size="sm" spacing="xs">
          {provider.steps(redirect).map((step, i) => (
            <List.Item key={i}>{step}</List.Item>
          ))}
        </List>
        <Text size="sm">
          Issuer URL: <Copyable value={provider.issuer} />
        </Text>
      </Stack>
    </Paper>
  );
}

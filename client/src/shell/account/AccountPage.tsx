import { useState } from "react";
import { Alert, Badge, Button, Divider, Group, Loader, Paper, Stack, Table, Text, Title } from "@mantine/core";
import { pageUrl, useApi } from "../../ui/api";
import { useSession } from "../../ui/session";
import { relativeTime } from "../../ui/time";
import { ChangePasswordForm } from "../auth/ChangePasswordForm";
import { PageHeader } from "../PageHeader";
import { TwoFactorSection } from "./TwoFactorSection";

export function AccountPage() {
  const { me, methods } = useSession();
  const account = useApi("GET /api/auth/account");
  const [changed, setChanged] = useState(false);

  if (me.source === "dev-bypass") {
    return (
      <>
        <PageHeader title="Account" />
        <Alert color="yellow" variant="light">
          Signed in through the development bypass. There is no account to manage.
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Account"
        description={`${me.name} · ${me.email || me.id} · signed in with ${me.source === "oidc" ? "SSO" : "a password"}`}
      />
      {account.error ? <Alert color="red">{account.error}</Alert> : null}
      {account.data === null && !account.error ? <Loader size="sm" /> : null}
      {account.data ? (
        <Paper withBorder p="lg" maw={760}>
          <Stack gap="lg">
            <Stack gap="xs">
              <Title order={4}>Single sign-on</Title>
              {account.data.identities.length === 0 ? (
                <Text size="sm" c="dimmed">
                  No SSO sign-in is linked to this account.
                </Text>
              ) : (
                account.data.identities.map((identity) => (
                  <Text size="sm" key={identity.provider}>
                    {identity.email || "Linked"}{" "}
                    <Text span c="dimmed">
                      via {hostOf(identity.provider)} · last used {relativeTime(identity.lastUsedAt)}
                    </Text>
                  </Text>
                ))
              )}
              {methods?.oidc ? (
                <Group>
                  <Button component="a" href={pageUrl("auth/oidc/start?link=1")} variant="default" size="xs">
                    Link {methods.oidc.label.replace(/^Sign in with /i, "")}
                  </Button>
                </Group>
              ) : null}
            </Stack>

            <Divider />
            <Stack gap="xs" maw={420}>
              <Title order={4}>{account.data.hasPassword ? "Change password" : "Set a password"}</Title>
              {changed ? (
                <Alert color="teal" variant="light">
                  Password saved. Your other sessions were signed out.
                </Alert>
              ) : (
                <ChangePasswordForm needsCurrent={account.data.hasPassword} onChanged={() => setChanged(true)} />
              )}
            </Stack>

            <Divider />
            <TwoFactorSection />

            <Divider />
            <Stack gap="xs">
              <Title order={4}>Sessions</Title>
              <Table fz="sm" verticalSpacing={4}>
                <Table.Tbody>
                  {account.data.sessions.map((session) => (
                    <Table.Tr key={session.id}>
                      <Table.Td>
                        {session.ip}
                        {session.current ? (
                          <Badge size="xs" ml="xs" variant="light">
                            this one
                          </Badge>
                        ) : null}
                      </Table.Td>
                      <Table.Td>{session.method === "oidc" ? "SSO" : "password"}</Table.Td>
                      <Table.Td c="dimmed" style={{ maxWidth: 260 }}>
                        <Text size="xs" truncate>
                          {session.userAgent}
                        </Text>
                      </Table.Td>
                      <Table.Td c="dimmed">{relativeTime(session.lastSeenAt)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Stack>
          </Stack>
        </Paper>
      ) : null}
    </>
  );
}

// Providers are recorded by issuer URL; the host is what a person recognises.
export function hostOf(provider: string): string {
  try {
    return new URL(provider).host;
  } catch {
    return provider;
  }
}

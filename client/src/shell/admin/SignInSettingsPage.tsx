import { useState } from "react";
import {
  Alert,
  Button,
  Code,
  CopyButton,
  Divider,
  Group,
  Loader,
  Paper,
  PasswordInput,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { apiRequest, useApi } from "../../ui/api";
import { PageHeader } from "../PageHeader";
import { SIGN_IN_GROUPS } from "./groups";
import { SettingField } from "./SettingField";

export function SignInSettingsPage() {
  const overview = useApi("GET /api/admin/overview");
  const [secret, setSecret] = useState("");
  const [secretError, setSecretError] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const data = overview.data;
  const header = <PageHeader title="Sign-in" description="Password and OIDC sign-in, trusted networks and sessions." />;
  if (!data) {
    return (
      <>
        {header}
        {overview.error ? <Alert color="red">{overview.error}</Alert> : <Loader size="sm" />}
      </>
    );
  }

  const saveSecret = async (value: string) => {
    setSecretError(null);
    try {
      await apiRequest("PUT /api/admin/oidc/secret", { body: { value } });
      setSecret("");
      overview.reload();
    } catch (err) {
      setSecretError((err as Error).message);
    }
  };

  const runTest = async () => {
    setTesting(true);
    try {
      const result = await apiRequest("POST /api/admin/oidc/test");
      setTest(
        result.ok
          ? { ok: true, text: `Discovery worked${result.issuer ? `: issuer ${result.issuer}` : ""}.` }
          : { ok: false, text: result.error ?? "Discovery failed." }
      );
    } catch (err) {
      setTest({ ok: false, text: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const group = (name: string) =>
    data.settings
      .filter((s) => s.group === name)
      .map((s) => <SettingField key={s.key} setting={s} onSaved={overview.reload} />);

  return (
    <>
      {header}
      <Paper withBorder p="lg" maw={760}>
        <Stack gap="xl">
          <Text size="sm" c="dimmed">
            You are connecting from <Code>{data.you.ip}</Code>. Trusted networks are optional everywhere; leave a list
            empty to allow sign-in from anywhere.
          </Text>

          <Stack gap="md">
            <Title order={4}>{SIGN_IN_GROUPS[0]}</Title>
            {group(SIGN_IN_GROUPS[0])}
          </Stack>

          <Divider />
          <Stack gap="md">
            <Title order={4}>{SIGN_IN_GROUPS[1]}</Title>
            {data.oidc.unavailable ? (
              <Alert color="gray" variant="light">
                Not active: {data.oidc.unavailable}
              </Alert>
            ) : null}
            <div>
              <Text size="sm" fw={500}>
                Redirect URI
              </Text>
              {data.oidc.redirectUri ? (
                <Group gap="xs">
                  <Code>{data.oidc.redirectUri}</Code>
                  <CopyButton value={data.oidc.redirectUri}>
                    {({ copied, copy }) => (
                      <Button size="compact-xs" variant="subtle" onClick={copy}>
                        {copied ? "Copied" : "Copy"}
                      </Button>
                    )}
                  </CopyButton>
                </Group>
              ) : (
                <Text size="xs" c="orange">
                  Set the public URL under Settings to get one.
                </Text>
              )}
              {data.publicUrl.source === "request" ? (
                <Text size="xs" c="orange">
                  Guessed from this page&apos;s address. Save the public URL under Settings to make it stick.
                </Text>
              ) : null}
              <Text size="xs" c="dimmed">
                Register this with your identity provider as the web redirect URI.
              </Text>
            </div>
            {group(SIGN_IN_GROUPS[1])}
            <Stack gap={4}>
              <PasswordInput
                label="Client secret"
                description={
                  data.oidc.hasSecret ? "A secret is stored. Enter a new one to replace it." : "No secret stored yet."
                }
                value={secret}
                onChange={(e) => setSecret(e.currentTarget.value)}
                disabled={!data.secretKeyConfigured}
                error={
                  secretError ??
                  (data.secretKeyConfigured ? undefined : "SECRETS_KEY is not set, so secrets cannot be stored.")
                }
                autoComplete="off"
              />
              <Group gap="xs">
                <Button size="xs" disabled={!secret.trim()} onClick={() => void saveSecret(secret)}>
                  Save secret
                </Button>
                {data.oidc.hasSecret ? (
                  <Button size="xs" variant="subtle" color="red" onClick={() => void saveSecret("")}>
                    Clear
                  </Button>
                ) : null}
                <Button size="xs" variant="default" loading={testing} onClick={() => void runTest()}>
                  Test discovery
                </Button>
              </Group>
              {test ? (
                <Text size="xs" c={test.ok ? "teal" : "red"}>
                  {test.text}
                </Text>
              ) : null}
            </Stack>
          </Stack>

          <Divider />
          <Stack gap="md">
            <Title order={4}>{SIGN_IN_GROUPS[2]}</Title>
            {group(SIGN_IN_GROUPS[2])}
          </Stack>
        </Stack>
      </Paper>
    </>
  );
}

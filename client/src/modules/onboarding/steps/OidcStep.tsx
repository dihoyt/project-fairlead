import { useEffect, useState } from "react";
import { Alert, Button, Code, Group, Loader, PasswordInput, Stack, Text, TextInput } from "@mantine/core";
import { OidcProviderGuide } from "../../../shell/admin/OidcProviderGuide";
import { apiRequest, useApi } from "../../../ui";
import { putSetting, settingOf, stringSetting } from "../settings";
import { StepFrame, useAction, type StepProps } from "../shared";

export function OidcStep({ onFinish }: StepProps) {
  const overview = useApi("GET /api/admin/overview");
  const settings = overview.data?.settings;
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [label, setLabel] = useState("");
  const [adminGroups, setAdminGroups] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; issuer?: string; error?: string }>();
  const save = useAction();

  useEffect(() => {
    if (!settings || loaded) return;
    setIssuer(stringSetting(settings, "auth.oidc.issuer"));
    setClientId(stringSetting(settings, "auth.oidc.clientId"));
    setLabel(stringSetting(settings, "auth.oidc.label"));
    const groups = settingOf(settings, "auth.oidc.adminGroups");
    setAdminGroups(Array.isArray(groups) ? groups.filter((g) => typeof g === "string").join(", ") : "");
    setLoaded(true);
  }, [settings, loaded]);

  const oidc = overview.data?.oidc;

  async function saveAndTest() {
    const tested = await save.run(async () => {
      await putSetting("auth.oidc.issuer", issuer.trim());
      await putSetting("auth.oidc.clientId", clientId.trim());
      if (label.trim()) await putSetting("auth.oidc.label", label.trim());
      await putSetting(
        "auth.oidc.adminGroups",
        adminGroups
          .split(",")
          .map((g) => g.trim())
          .filter(Boolean)
      );
      if (secret) await apiRequest("PUT /api/admin/oidc/secret", { body: { value: secret } });
      await putSetting("auth.oidc.enabled", true);
      return apiRequest("POST /api/admin/oidc/test");
    });
    if (tested) {
      setResult(tested);
      setSecret("");
      overview.reload();
    }
  }

  return (
    <StepFrame
      onFinish={onFinish}
      intro="Sign in through your identity provider (Entra ID, Authentik, Keycloak, Google, …) instead of local passwords. The local admin keeps working as a fallback. Skip this to stay on local accounts."
      fullPage={{ to: "/admin/sign-in", label: "All sign-in settings" }}
      canFinish={result?.ok === true}
    >
      {overview.loading && !overview.data ? <Loader size="sm" /> : null}
      {overview.error ? <Alert color="red">{overview.error}</Alert> : null}
      {oidc ? (
        <Stack gap="sm">
          <Text size="sm">
            Register an app with your provider using this redirect URI: <Code>{oidc.redirectUri}</Code>
          </Text>
          <OidcProviderGuide redirectUri={oidc.redirectUri} />
          {overview.data?.publicUrl.source === "request" ? (
            <Text size="xs" c="orange">
              Guessed from this page&apos;s address. Save the public URL on the first setup step to make it stick.
            </Text>
          ) : null}
          {oidc.unavailable && overview.data?.publicUrl.source !== "request" ? (
            <Alert color="yellow">{oidc.unavailable}</Alert>
          ) : null}
          {overview.data && !overview.data.secretKeyConfigured ? (
            <Alert color="yellow">SECRETS_KEY is not set, so a client secret cannot be stored.</Alert>
          ) : null}
          <TextInput
            label="Issuer URL"
            placeholder="https://login.microsoftonline.com/<tenant>/v2.0"
            value={issuer}
            onChange={(e) => setIssuer(e.currentTarget.value)}
          />
          <TextInput label="Client ID" value={clientId} onChange={(e) => setClientId(e.currentTarget.value)} />
          <PasswordInput
            label="Client secret"
            description={oidc.hasSecret ? "A secret is stored; leave empty to keep it." : undefined}
            value={secret}
            onChange={(e) => setSecret(e.currentTarget.value)}
          />
          <TextInput
            label="Button label"
            placeholder="Sign in with Entra ID"
            value={label}
            onChange={(e) => setLabel(e.currentTarget.value)}
          />
          <TextInput
            label="Admin groups"
            description="Comma-separated group names or IDs from the groups claim; members are admins."
            value={adminGroups}
            onChange={(e) => setAdminGroups(e.currentTarget.value)}
          />
          {save.error ? <Alert color="red">{save.error}</Alert> : null}
          {result ? (
            <Alert color={result.ok ? "green" : "red"} title={result.ok ? "Provider reachable" : "Test failed"}>
              {result.ok ? `Discovery worked for ${result.issuer ?? issuer}.` : result.error}
            </Alert>
          ) : null}
          <Group>
            <Button variant="default" loading={save.busy} disabled={!issuer || !clientId} onClick={saveAndTest}>
              Save and test
            </Button>
          </Group>
        </Stack>
      ) : null}
    </StepFrame>
  );
}

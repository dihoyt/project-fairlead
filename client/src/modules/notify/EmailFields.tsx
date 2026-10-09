import {
  Alert,
  Code,
  CopyButton,
  Group,
  NumberInput,
  Select,
  Stack,
  TagsInput,
  Text,
  TextInput,
  Button,
} from "@mantine/core";
import {
  EMAIL_PRESETS,
  type EmailConfig,
  type EmailPreset,
  type EmailSetupView,
  type SmtpSecurity,
} from "@contracts/notify";

const PRESET_GROUPS: { group: string; items: EmailPreset[] }[] = [
  { group: "App password (SMTP)", items: ["gmail", "yahoo", "icloud", "fastmail"] },
  { group: "Sending service (SMTP)", items: ["sendgrid", "mailgun", "ses", "smtp"] },
  { group: "Sign in to send", items: ["google-oauth", "microsoft-oauth"] },
  { group: "Microsoft 365", items: ["entra"] },
];

export const emptyEmail = (): EmailConfig => ({ ...presetDefaults("gmail"), to: [] });

// The SMTP settings a preset fills in; switching preset replaces them.
function presetDefaults(preset: EmailPreset): EmailConfig {
  const info = EMAIL_PRESETS[preset];
  const config: EmailConfig = { preset, to: [] };
  if (info.mode === "smtp") {
    config.host = info.host ?? "";
    config.port = info.port ?? 587;
    config.security = info.security ?? "starttls";
    if (info.username) config.username = info.username;
  }
  return config;
}

// The secret field's label for a preset, or null when it takes none.
export function emailSecretField(preset: EmailPreset): { label: string; description: string } | null {
  const mode = EMAIL_PRESETS[preset].mode;
  if (mode === "entra") return null;
  if (mode === "oauth") return { label: "Client secret", description: "Stored encrypted." };
  return {
    label: preset === "sendgrid" ? "API key" : "Password or app password",
    description: "Stored encrypted. Leave empty for a relay that needs no sign-in.",
  };
}

export function EmailFields({
  value,
  onChange,
  setup,
  account,
  editing,
}: {
  value: EmailConfig;
  onChange: (next: EmailConfig) => void;
  setup?: EmailSetupView;
  // The signed-in address of a saved "sign in to send" channel.
  account?: string;
  editing: boolean;
}) {
  const info = EMAIL_PRESETS[value.preset];
  const set = (patch: Partial<EmailConfig>) => onChange({ ...value, ...patch });

  function pick(preset: EmailPreset) {
    const next = { ...presetDefaults(preset), to: value.to, ...(value.from ? { from: value.from } : {}) };
    const signInClient = setup?.signInClient;
    if (
      signInClient &&
      EMAIL_PRESETS[preset].mode === "oauth" &&
      signInClient.provider === EMAIL_PRESETS[preset].provider
    ) {
      next.clientId = signInClient.clientId;
    }
    onChange(next);
  }

  return (
    <Stack gap="sm">
      <Select
        label="Send with"
        value={value.preset}
        onChange={(preset) => preset && pick(preset as EmailPreset)}
        allowDeselect={false}
        data={PRESET_GROUPS.map(({ group, items }) => ({
          group,
          items: items.map((p) => ({ value: p, label: EMAIL_PRESETS[p].label })),
        }))}
      />
      <Text size="xs" c="dimmed">
        {info.help}
      </Text>

      {info.mode === "smtp" && (
        <>
          <Group grow align="flex-start">
            <TextInput
              label="SMTP server"
              required
              placeholder={value.preset === "ses" ? "email-smtp.eu-west-1.amazonaws.com" : "smtp.example.com"}
              value={value.host ?? ""}
              onChange={(e) => set({ host: e.currentTarget.value })}
            />
            <NumberInput
              label="Port"
              min={1}
              max={65535}
              maw={110}
              value={value.port ?? 587}
              onChange={(port) => set({ port: typeof port === "number" ? port : 587 })}
            />
          </Group>
          <Select
            label="Encryption"
            value={value.security ?? "starttls"}
            onChange={(security) => set({ security: (security as SmtpSecurity) ?? "starttls" })}
            allowDeselect={false}
            data={[
              { value: "starttls", label: "STARTTLS (usually port 587)" },
              { value: "tls", label: "TLS from the start (usually port 465)" },
              { value: "none", label: "None (a relay inside your network)" },
            ]}
          />
          <TextInput
            label="Username"
            description={info.username ? undefined : "Usually the full email address."}
            value={value.username ?? ""}
            onChange={(e) => set({ username: e.currentTarget.value })}
          />
        </>
      )}

      {info.mode === "oauth" && (
        <>
          <TextInput
            label="OAuth client ID"
            required
            description={
              setup?.signInClient?.provider === info.provider
                ? "Filled in from the client sign-in uses; you can use a separate one."
                : undefined
            }
            value={value.clientId ?? ""}
            onChange={(e) => set({ clientId: e.currentTarget.value })}
          />
          {setup?.redirectUri ? (
            <Group gap="xs" wrap="nowrap">
              <Text size="sm">Redirect URI:</Text>
              <Code>{setup.redirectUri}</Code>
              <CopyButton value={setup.redirectUri}>
                {({ copied, copy }) => (
                  <Button size="compact-xs" variant="subtle" onClick={copy}>
                    {copied ? "Copied" : "Copy"}
                  </Button>
                )}
              </CopyButton>
            </Group>
          ) : null}
          {setup?.oauthBlocked && (
            <Alert color="yellow" variant="light">
              {setup.oauthBlocked}
            </Alert>
          )}
          {editing && (
            <Text size="sm" c={account ? undefined : "yellow"}>
              {account ? `Sending as ${account}.` : "Nobody has signed in yet."} Saving takes you to sign in
              {account ? " only if the client changes" : ""}.
            </Text>
          )}
          {!editing && (
            <Text size="sm" c="dimmed">
              Adding the channel takes you to sign in to the account that sends.
            </Text>
          )}
        </>
      )}

      {info.mode === "entra" && setup && !setup.entra.ready && (
        <Alert color="yellow" variant="light">
          {setup.entra.reason ?? "The Microsoft Entra ID connector is not ready."}
        </Alert>
      )}

      <TextInput
        label="From"
        required={info.mode !== "oauth"}
        description={info.mode === "oauth" ? "Leave empty to send as the account that signs in." : undefined}
        placeholder="alerts@example.com"
        value={value.from ?? ""}
        onChange={(e) => set({ from: e.currentTarget.value })}
      />
      <TagsInput
        label="To"
        required
        description="Press Enter after each address."
        placeholder="ops@example.com"
        value={value.to}
        onChange={(to) => set({ to })}
        splitChars={[",", " ", ";"]}
        maxTags={20}
      />
    </Stack>
  );
}

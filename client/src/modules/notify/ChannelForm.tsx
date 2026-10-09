import { useCallback, useState } from "react";
import { Alert, Button, Group, PasswordInput, SegmentedControl, Select, Stack, Switch, TextInput } from "@mantine/core";
import type { ChannelRequest, ChannelView } from "@contracts/notify";
import {
  CHANNEL_CHOICES,
  choiceKind,
  PUBLIC_NTFY,
  SelfHostedNtfy,
  type ChannelChoice,
  type WebhookKind,
} from "./ntfyChoice";

const SECRET_FIELD: Record<WebhookKind, { label: string; placeholder: string; description: string }> = {
  webhook: {
    label: "URL",
    placeholder: "https://example.com/hooks/health",
    description: "Receives a JSON POST for every change. Stored encrypted; may include a token.",
  },
  discord: {
    label: "Discord webhook URL",
    placeholder: "https://discord.com/api/webhooks/…",
    description: "Channel settings → Integrations → Webhooks → Copy Webhook URL.",
  },
  ntfy: {
    label: "Access token (optional)",
    placeholder: "tk_…",
    description: "Only for a protected topic.",
  },
};

function initialChoice(channel: ChannelView): ChannelChoice {
  if (channel.kind === "email") return "webhook";
  if (channel.kind !== "ntfy") return channel.kind;
  return (channel.config.server ?? PUBLIC_NTFY) === PUBLIC_NTFY ? "ntfy-public" : "ntfy-self";
}

export function ChannelForm({
  channel,
  onSubmit,
  onCancel,
}: {
  channel?: ChannelView;
  onSubmit: (req: ChannelRequest) => Promise<void>;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState<ChannelChoice>(channel ? initialChoice(channel) : "ntfy-public");
  const kind = choiceKind(choice);
  const [label, setLabel] = useState(channel?.label ?? "");
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [minSeverity, setMinSeverity] = useState<"warn" | "crit">(channel?.minSeverity ?? "warn");
  const [server, setServer] = useState(channel?.config.server ?? PUBLIC_NTFY);
  const [topic, setTopic] = useState(channel?.config.topic ?? "");
  const [secret, setSecret] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const takeServer = useCallback((url: string) => setServer(url), []);

  function pick(next: ChannelChoice) {
    setChoice(next);
    if (next === "ntfy-public") setServer(PUBLIC_NTFY);
    else if (next === "ntfy-self" && server === PUBLIC_NTFY) setServer("");
  }

  const field = SECRET_FIELD[kind];
  const editing = channel !== undefined;

  async function submit() {
    const req: ChannelRequest = { kind, label, enabled, minSeverity };
    if (kind === "ntfy") req.config = { server, topic };
    if (clearSecret) req.secret = "";
    else if (secret) req.secret = secret;
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit(req);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack>
      {!editing && (
        <SegmentedControl value={choice} onChange={(value) => pick(value as ChannelChoice)} data={CHANNEL_CHOICES} />
      )}
      {!editing && choice === "ntfy-self" && <SelfHostedNtfy onServer={takeServer} />}
      <TextInput label="Name" required value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
      {kind === "ntfy" && (
        <>
          <TextInput label="Server" value={server} onChange={(e) => setServer(e.currentTarget.value)} />
          <TextInput label="Topic" required value={topic} onChange={(e) => setTopic(e.currentTarget.value)} />
        </>
      )}
      <PasswordInput
        label={field.label}
        description={
          editing && channel.hasSecret ? `${field.description} Leave empty to keep the stored one.` : field.description
        }
        placeholder={editing && channel.hasSecret ? "•••••• stored" : field.placeholder}
        required={!editing && kind !== "ntfy"}
        value={secret}
        disabled={clearSecret}
        onChange={(e) => setSecret(e.currentTarget.value)}
      />
      {editing && kind === "ntfy" && channel.hasSecret && (
        <Switch
          label="Remove the stored token"
          checked={clearSecret}
          onChange={(e) => setClearSecret(e.currentTarget.checked)}
        />
      )}
      <Select
        label="Send changes into"
        value={minSeverity}
        onChange={(value) => setMinSeverity((value as "warn" | "crit") ?? "warn")}
        allowDeselect={false}
        data={[
          { value: "warn", label: "Warning or critical" },
          { value: "crit", label: "Critical only" },
        ]}
        description="Recoveries are sent for anything this channel was told about."
      />
      <Switch label="Enabled" checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}
      <Group justify="flex-end">
        <Button variant="default" onClick={onCancel}>
          Cancel
        </Button>
        <Button loading={busy} onClick={() => void submit()}>
          {editing ? "Save" : "Add channel"}
        </Button>
      </Group>
    </Stack>
  );
}

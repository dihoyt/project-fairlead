import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Group,
  PasswordInput,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import type { ChannelRequest, TestSendResult } from "@contracts/notify";
import { apiRequest, useApi } from "../../../ui";
import {
  CHANNEL_CHOICES,
  choiceKind,
  PUBLIC_NTFY,
  SelfHostedNtfy,
  useOwnNtfy,
  type ChannelChoice,
  type WebhookKind,
} from "../../notify/ntfyChoice";
import { StepFrame, useAction, type StepProps } from "../shared";

const SECRET: Record<WebhookKind, { label: string; placeholder: string; required: boolean }> = {
  ntfy: { label: "Access token (protected topics only)", placeholder: "tk_…", required: false },
  discord: { label: "Discord webhook URL", placeholder: "https://discord.com/api/webhooks/…", required: true },
  webhook: { label: "Webhook URL", placeholder: "https://example.com/hooks/health", required: true },
};

export function NotificationsStep({ onFinish }: StepProps) {
  const channels = useApi("GET /api/notify/channels");
  const [choice, setChoice] = useState<ChannelChoice>("ntfy-public");
  const kind = choiceKind(choice);
  const [label, setLabel] = useState("");
  const [server, setServer] = useState(PUBLIC_NTFY);
  const [topic, setTopic] = useState("");
  const [secret, setSecret] = useState("");
  const [sent, setSent] = useState<{ label: string; result: TestSendResult }>();
  const action = useAction();
  const ownNtfy = useOwnNtfy().url;
  const takeServer = useCallback((url: string) => setServer(url), []);

  // An ntfy server already in the cluster is the one to use.
  useEffect(() => {
    if (ownNtfy) setChoice((prev) => (prev === "ntfy-public" ? "ntfy-self" : prev));
  }, [ownNtfy]);

  function pick(next: ChannelChoice) {
    setChoice(next);
    if (next === "ntfy-public") setServer(PUBLIC_NTFY);
    else if (next === "ntfy-self" && server === PUBLIC_NTFY) setServer(ownNtfy ?? "");
  }

  const ready = kind === "ntfy" ? topic.trim() !== "" && server.trim() !== "" : secret.trim() !== "";

  async function addAndTest() {
    setSent(undefined);
    const req: ChannelRequest = { kind, label: label.trim() || kind, minSeverity: "warn" };
    if (kind === "ntfy") req.config = { server: server.trim(), topic: topic.trim() };
    if (secret.trim()) req.secret = secret.trim();
    const outcome = await action.run(async () => {
      const channel = await apiRequest("POST /api/notify/channels", { body: req });
      const result = await apiRequest("POST /api/notify/channels/:id/test", { params: { id: channel.id } });
      return { label: channel.label, result };
    });
    if (!outcome) return;
    setSent(outcome);
    setSecret("");
    channels.reload();
  }

  async function retest(id: string, channelLabel: string) {
    const result = await action.run(() => apiRequest("POST /api/notify/channels/:id/test", { params: { id } }));
    if (result) setSent({ label: channelLabel, result });
  }

  const list = channels.data ?? [];

  return (
    <StepFrame
      onFinish={onFinish}
      what="Alerts go to a chat app, a webhook or ntfy, which sends push notifications to the ntfy app on your phone. Use the public ntfy.sh server, or deploy your own in this cluster."
      intro="Where a check going to warning or critical is sent, and its recovery. Add one and a test message goes out straight away."
      fullPage={{ to: "/notifications", label: "Notifications page" }}
      canFinish={list.length > 0}
    >
      {list.length ? (
        <Stack gap={4}>
          {list.map((channel) => (
            <Group key={channel.id} gap="xs">
              <Text size="sm">
                {channel.label} ({channel.kind})
              </Text>
              <Button size="compact-xs" variant="subtle" onClick={() => void retest(channel.id, channel.label)}>
                Send test
              </Button>
            </Group>
          ))}
        </Stack>
      ) : null}
      <SegmentedControl value={choice} onChange={(v) => pick(v as ChannelChoice)} data={CHANNEL_CHOICES} />
      {choice === "ntfy-self" ? <SelfHostedNtfy onServer={takeServer} /> : null}
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput label="Name" placeholder="Phone" value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
        {kind === "ntfy" ? (
          <>
            <TextInput label="Server" value={server} onChange={(e) => setServer(e.currentTarget.value)} />
            <TextInput label="Topic" value={topic} onChange={(e) => setTopic(e.currentTarget.value)} />
          </>
        ) : null}
      </SimpleGrid>
      <PasswordInput
        label={SECRET[kind].label}
        placeholder={SECRET[kind].placeholder}
        description="Stored encrypted, never shown again."
        value={secret}
        onChange={(e) => setSecret(e.currentTarget.value)}
      />
      {action.error ? <Alert color="red">{action.error}</Alert> : null}
      {sent ? (
        <Alert color={sent.result.ok ? "green" : "red"} title={sent.result.ok ? "Test sent" : "Test failed"}>
          {sent.result.ok
            ? `Check that "${sent.label}" received it.`
            : `${sent.result.error ?? "Send failed"}${sent.result.status ? ` (HTTP ${sent.result.status})` : ""}`}
        </Alert>
      ) : null}
      <Group>
        <Button variant="default" loading={action.busy} disabled={!ready} onClick={addAndTest}>
          Add and send a test
        </Button>
      </Group>
    </StepFrame>
  );
}

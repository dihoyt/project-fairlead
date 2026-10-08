import { useEffect, useState } from "react";
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
import type { ChannelKind, ChannelRequest, TestSendResult } from "@contracts/notify";
import { apiRequest, useApi } from "../../../ui";
import { AppOffer, useDiscovery } from "../discovery";
import { StepFrame, useAction, type StepProps } from "../shared";

const PUBLIC_NTFY = "https://ntfy.sh";

const SECRET: Record<ChannelKind, { label: string; placeholder: string; required: boolean }> = {
  ntfy: { label: "Access token (protected topics only)", placeholder: "tk_…", required: false },
  discord: { label: "Discord webhook URL", placeholder: "https://discord.com/api/webhooks/…", required: true },
  webhook: { label: "Webhook URL", placeholder: "https://example.com/hooks/health", required: true },
};

export function NotificationsStep({ onFinish }: StepProps) {
  const channels = useApi("GET /api/notify/channels");
  const [kind, setKind] = useState<ChannelKind>("ntfy");
  const [label, setLabel] = useState("");
  const [server, setServer] = useState(PUBLIC_NTFY);
  const [topic, setTopic] = useState("");
  const [secret, setSecret] = useState("");
  const [sent, setSent] = useState<{ label: string; result: TestSendResult }>();
  const action = useAction();
  const discovery = useDiscovery();
  const ntfy = discovery.app("ntfy");
  const ownNtfy = ntfy?.detected.state === "installed" ? ntfy.detected.urls[0] : undefined;

  // An ntfy server in the cluster replaces the public one, unless someone
  // already typed another.
  useEffect(() => {
    if (ownNtfy) setServer((prev) => (prev === PUBLIC_NTFY ? ownNtfy.replace(/\/+$/, "") : prev));
  }, [ownNtfy]);

  const ready = kind === "ntfy" ? topic.trim() !== "" : secret.trim() !== "";

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
      what="Alerts go to a chat app, a webhook or ntfy, which sends push notifications to the ntfy app on your phone."
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
      {ntfy && ntfy.detected.state !== "installed" ? (
        <AppOffer
          app={ntfy}
          onDeployed={(result) => {
            setKind("ntfy");
            if (result.url) setServer(result.url.replace(/\/+$/, ""));
            discovery.refresh();
          }}
        />
      ) : null}
      <SegmentedControl
        value={kind}
        onChange={(v) => setKind(v as ChannelKind)}
        data={[
          { value: "ntfy", label: "ntfy" },
          { value: "discord", label: "Discord" },
          { value: "webhook", label: "Webhook" },
        ]}
      />
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

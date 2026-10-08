import { useEffect } from "react";
import { Group, Paper, Stack, Text } from "@mantine/core";
import type { ChannelKind } from "@contracts/notify";
import { useApi } from "../../ui";
import { DeployButton } from "../../ui/deploy";

export const PUBLIC_NTFY = "https://ntfy.sh";

// One ntfy kind on the server; the form tells the public server and one in
// this cluster apart, because only the second needs deploying first.
export type ChannelChoice = "ntfy-self" | "ntfy-public" | "discord" | "webhook";

export const CHANNEL_CHOICES: { value: ChannelChoice; label: string }[] = [
  { value: "ntfy-self", label: "Self-hosted ntfy" },
  { value: "ntfy-public", label: "ntfy.sh" },
  { value: "discord", label: "Discord" },
  { value: "webhook", label: "Webhook" },
];

export const choiceKind = (choice: ChannelChoice): ChannelKind =>
  choice === "ntfy-self" || choice === "ntfy-public" ? "ntfy" : choice;

const trim = (url: string) => url.replace(/\/+$/, "");

// The cluster's own ntfy: its URL once found, else undefined. `loaded` is
// false until the catalog has answered.
export function useOwnNtfy() {
  const apps = useApi("GET /api/catalog/apps");
  const ntfy = apps.data?.find((app) => app.id === "ntfy");
  const url = ntfy?.detected.state === "installed" ? ntfy.detected.urls[0] : undefined;
  return {
    url: url ? trim(url) : undefined,
    offered: ntfy !== undefined,
    loaded: apps.data !== null,
    reload: apps.reload,
  };
}

// Where a self-hosted ntfy channel points: the cluster's ntfy when there is
// one, otherwise a Deploy button that installs it and hands back its URL.
export function SelfHostedNtfy({ onServer }: { onServer: (server: string) => void }) {
  const own = useOwnNtfy();
  useEffect(() => {
    if (own.url) onServer(own.url);
  }, [own.url, onServer]);

  if (!own.loaded) return null;
  if (own.url) {
    return (
      <Text size="sm" c="dimmed">
        Using the ntfy server in this cluster at {own.url}.
      </Text>
    );
  }
  return (
    <Paper withBorder p="sm" data-offer="ntfy">
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap">
          <Text size="sm">No ntfy server in this cluster yet.</Text>
          {own.offered ? (
            <DeployButton
              appId="ntfy"
              label="Deploy ntfy"
              size="xs"
              onDeployed={(result) => {
                if (result.url) onServer(trim(result.url));
                own.reload();
              }}
            />
          ) : null}
        </Group>
        <Text size="xs" c="dimmed">
          Deploys ntfy here and points this channel at it. Install the ntfy app on your phone and subscribe to the
          topic.
        </Text>
      </Stack>
    </Paper>
  );
}

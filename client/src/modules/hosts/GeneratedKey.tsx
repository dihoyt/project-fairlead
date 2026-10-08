import { useState } from "react";
import { ActionIcon, Alert, Button, Code, CopyButton, Group, Stack, Text, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import type { HostKeypair } from "@contracts/hosts";
import { apiRequest, relativeTime, useApi, type ApiResource } from "../../ui";

export type KeypairResource = ApiResource<{ keypair: HostKeypair | null }>;

// A form inside a page that already loads the key pair shares the page's
// copy, so generating it in one place updates both.
export function useKeypair(shared?: KeypairResource): KeypairResource {
  const own = useApi("GET /api/hosts/keypair", undefined, { enabled: !shared });
  return shared ?? own;
}

function CopyCommand({ command }: { command: string }) {
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Code block style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {command}
      </Code>
      <CopyButton value={command}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? "Copied" : "Copy"} withArrow>
            <ActionIcon variant="light" color={copied ? "teal" : undefined} onClick={copy} aria-label="Copy command">
              {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );
}

// The install's own key pair: generate it once, then paste the one-liner on
// each host as the user the app will sign in as.
export function GeneratedKey({
  resource,
  canGenerate,
  allowRotate = false,
}: {
  resource: KeypairResource;
  canGenerate: boolean;
  allowRotate?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmRotate, setConfirmRotate] = useState(false);
  const pair = resource.data?.keypair ?? null;

  async function generate(rotate: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      await apiRequest("POST /api/hosts/keypair", rotate ? { query: { rotate: "1" } } : {});
      setConfirmRotate(false);
      resource.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (resource.loading && !resource.data) return <Text size="sm">Loading the key…</Text>;

  return (
    <Stack gap="xs">
      {resource.error && (
        <Alert color="red" variant="light">
          {resource.error}
        </Alert>
      )}
      {pair ? (
        <>
          <Text size="sm">
            On each host, sign in as the user the app will use and run this once. It adds the app's public key to that
            user's <Code>~/.ssh/authorized_keys</Code>; the private key never leaves the app.
          </Text>
          <CopyCommand command={pair.installCommand} />
          <Text size="xs" c="dimmed">
            Key <Code>{pair.fingerprint}</Code>, created {relativeTime(pair.createdAt)}.
          </Text>
          {allowRotate && canGenerate && (
            <Group gap="xs">
              {confirmRotate ? (
                <>
                  <Text size="sm" c="orange">
                    Hosts using the current key stop connecting until the new one is installed on them.
                  </Text>
                  <Button size="compact-sm" color="orange" loading={busy} onClick={() => void generate(true)}>
                    Replace the key
                  </Button>
                  <Button size="compact-sm" variant="default" onClick={() => setConfirmRotate(false)}>
                    Keep it
                  </Button>
                </>
              ) : (
                <Button size="compact-sm" variant="subtle" onClick={() => setConfirmRotate(true)}>
                  Rotate key
                </Button>
              )}
            </Group>
          )}
        </>
      ) : canGenerate ? (
        <Group gap="sm">
          <Button size="sm" loading={busy} onClick={() => void generate(false)}>
            Generate key
          </Button>
          <Text size="sm" c="dimmed">
            The app makes its own SSH key; you paste one line on each host.
          </Text>
        </Group>
      ) : (
        <Text size="sm" c="dimmed">
          No key has been generated yet. An admin can generate one.
        </Text>
      )}
      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}
    </Stack>
  );
}

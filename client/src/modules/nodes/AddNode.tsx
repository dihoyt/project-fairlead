import { useState } from "react";
import {
  ActionIcon,
  Alert,
  Button,
  Code,
  CopyButton,
  Group,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import type { JoinLink, JoinRole } from "@contracts/cluster";
import { apiRequest, useApi } from "../../ui";

const ROLE_LABELS: Record<JoinRole, string> = { agent: "Worker", server: "Control plane" };

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

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

// Makes a single-use join link and shows the one-liner to run on the new
// machine. The link is shown only here, once: the server keeps a hash.
export function AddNode({ canCreate, framed = true }: { canCreate: boolean; framed?: boolean }) {
  const status = useApi("GET /api/cluster/join");
  const [role, setRole] = useState<JoinRole>("agent");
  const [link, setLink] = useState<JoinLink>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function create() {
    setBusy(true);
    setError(undefined);
    try {
      const baseUrl = new URL(".", document.baseURI).toString();
      setLink(await apiRequest("POST /api/cluster/join-links", { body: { role, baseUrl } }));
      status.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function revokeAll() {
    setError(undefined);
    try {
      for (const open of status.data?.links ?? []) {
        await apiRequest("DELETE /api/cluster/join-links/:id", { params: { id: open.id } });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    status.reload();
  }

  const data = status.data;
  const body = (
    <Stack gap="xs">
      <Title order={5}>Add a node</Title>
      {status.error && (
        <Alert color="red" variant="light">
          {status.error}
        </Alert>
      )}
      {data && data.state !== "on" && (
        <Text size="sm" c="dimmed">
          {data.reason ?? "Adding nodes from here isn't available on this cluster."} You can still join one by hand; see
          “Adding nodes” in the install guide.
        </Text>
      )}
      {data?.state === "on" && (
        <>
          <Text size="sm">
            Run one command on the new machine (Linux, with sudo) to install k3s {data.k3sVersion}, the storage packages
            Longhorn and NFS need, and join it to this cluster. It appears in the nodes list once it is Ready.
          </Text>
          {!canCreate ? (
            <Text size="sm" c="dimmed">
              An admin can make the link.
            </Text>
          ) : link ? (
            <>
              <CopyCommand command={link.command} />
              <Text size="xs" c="dimmed">
                Works once, until {clock(link.expiresAt)}, as a {ROLE_LABELS[link.role].toLowerCase()} node. Anyone with
                it can join a machine to the cluster, so treat it like a password.
                {link.url.startsWith("http:") &&
                  " It is served over plain HTTP, so use it only on a network you trust."}
              </Text>
              <Group>
                <Button size="xs" variant="default" onClick={() => setLink(undefined)}>
                  Done
                </Button>
              </Group>
            </>
          ) : (
            <Group gap="xs">
              {data.roles.length > 1 && (
                <SegmentedControl
                  size="xs"
                  value={role}
                  onChange={(value) => setRole(value as JoinRole)}
                  data={data.roles.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
                />
              )}
              <Button size="xs" loading={busy} onClick={() => void create()}>
                Make a join link
              </Button>
              {data.links.length > 0 && (
                <>
                  <Text size="xs" c="dimmed">
                    {data.links.length} unused link{data.links.length === 1 ? "" : "s"} still open.
                  </Text>
                  <Button size="xs" variant="subtle" color="red" onClick={() => void revokeAll()}>
                    Revoke
                  </Button>
                </>
              )}
            </Group>
          )}
          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
        </>
      )}
    </Stack>
  );
  return framed ? (
    <Paper withBorder p="md">
      {body}
    </Paper>
  ) : (
    body
  );
}

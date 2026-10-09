import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Code,
  CopyButton,
  Group,
  Modal,
  NumberInput,
  Paper,
  SegmentedControl,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import type { ApiTokenScope, ApiTokenView, NewApiToken } from "@contracts/auth";
import { MCP_PATH, MCP_TOOLS } from "@contracts/mcp";
import { product } from "../../product";
import { apiRequest, useApi } from "../../ui/api";
import { relativeTime } from "../../ui/time";
import { PageHeader } from "../PageHeader";
import { GrantFields, NO_LIMITS, limitsBody, limitsProblem, limitsSummary, type GrantLimits } from "./GrantFields";

// The Claude Code command for this install, with the token filled in when
// it has just been made and a placeholder otherwise.
export function claudeCommand(publicUrl: string, secret = "<token>"): string {
  const base = publicUrl.replace(/\/+$/, "");
  return `claude mcp add --transport http ${product.slug} ${base}${MCP_PATH} --header "Authorization: Bearer ${secret}"`;
}

function Copyable({ value }: { value: string }) {
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Code block style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {value}
      </Code>
      <CopyButton value={value}>
        {({ copied, copy }) => (
          <Button size="compact-xs" variant="subtle" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </Button>
        )}
      </CopyButton>
    </Group>
  );
}

function NewToken({ created, publicUrl, onDone }: { created: NewApiToken; publicUrl: string; onDone: () => void }) {
  return (
    <Alert color="teal" variant="light" withCloseButton onClose={onDone} title={`Token "${created.token.name}"`}>
      <Stack gap="xs">
        <Copyable value={created.secret} />
        <Text size="xs">Shown once. Store it where the client that uses it can read it; it cannot be shown again.</Text>
        <Text size="xs" fw={500}>
          Add it to Claude Code:
        </Text>
        <Copyable value={claudeCommand(publicUrl, created.secret)} />
      </Stack>
    </Alert>
  );
}

function CreateToken({ onCreated }: { onCreated: (created: NewApiToken) => void }) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ApiTokenScope>("read");
  const [days, setDays] = useState<number | string>(90);
  const [limits, setLimits] = useState<GrantLimits>(NO_LIMITS);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const problem = limitsProblem(limits);

  async function create() {
    setBusy(true);
    try {
      const expiresInDays = typeof days === "number" && days > 0 ? days : null;
      onCreated(
        await apiRequest("POST /api/admin/tokens", {
          body: { name: name.trim(), scope, expiresInDays, ...limitsBody(limits) },
        })
      );
      setName("");
      setLimits(NO_LIMITS);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Group align="flex-end" wrap="wrap">
          <TextInput
            label="Name"
            placeholder="Claude Code on my laptop"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            w={260}
          />
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              Scope
            </Text>
            <SegmentedControl
              size="xs"
              value={scope}
              onChange={(value) => setScope(value as ApiTokenScope)}
              data={[
                { value: "read", label: "Read" },
                { value: "write", label: "Read and write" },
              ]}
            />
          </Stack>
          <NumberInput
            label="Expires after (days)"
            description="Empty: never"
            min={1}
            max={3650}
            value={days}
            onChange={setDays}
            w={160}
          />
          <Button onClick={() => void create()} loading={busy} disabled={!name.trim() || problem !== null}>
            Create token
          </Button>
        </Group>
        <GrantFields value={limits} onChange={setLimits} />
        {problem ? (
          <Text size="xs" c="orange">
            {problem}
          </Text>
        ) : null}
        {error ? <Alert color="red">{error}</Alert> : null}
      </Stack>
    </Paper>
  );
}

const limitsOf = (token: ApiTokenView): GrantLimits => ({
  namespaces: token.namespaces ?? null,
  areas: token.areas ?? null,
});

function EditToken({ token, onClose, onSaved }: { token: ApiTokenView; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(token.name);
  const [scope, setScope] = useState<ApiTokenScope>(token.scope);
  const [limits, setLimits] = useState<GrantLimits>(() => limitsOf(token));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const problem = limitsProblem(limits);

  async function save() {
    setBusy(true);
    try {
      await apiRequest("PATCH /api/admin/tokens/:id", {
        params: { id: token.id },
        body: { name: name.trim(), scope, namespaces: limits.namespaces, areas: limits.areas },
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal opened onClose={onClose} title={`Edit "${token.name}"`} size="lg">
      <Stack gap="sm">
        <TextInput label="Token name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <SegmentedControl
          size="xs"
          value={scope}
          onChange={(value) => setScope(value as ApiTokenScope)}
          data={[
            { value: "read", label: "Read" },
            { value: "write", label: "Read and write" },
          ]}
        />
        <GrantFields value={limits} onChange={setLimits} />
        <Text size="xs" c="dimmed">
          Changes apply to the token's next request; its secret stays the same.
        </Text>
        {problem ? (
          <Text size="xs" c="orange">
            {problem}
          </Text>
        ) : null}
        {error ? <Alert color="red">{error}</Alert> : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={!name.trim() || problem !== null}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function TokensPage() {
  const tokens = useApi("GET /api/admin/tokens");
  const overview = useApi("GET /api/admin/overview");
  const [created, setCreated] = useState<NewApiToken | null>(null);
  const [editing, setEditing] = useState<ApiTokenView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const publicUrl = overview.data?.publicUrl.value ?? new URL(document.baseURI).origin;

  async function revoke(id: string) {
    try {
      await apiRequest("DELETE /api/admin/tokens/:id", { params: { id } });
      setError(null);
      tokens.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="API tokens"
        description="Tokens let scripts and AI assistants such as Claude use this install through its API and MCP server. A token acts as you: read tokens can only look, write tokens can change what you can. Either can be limited to some areas and namespaces."
      />
      <Stack gap="md">
        {editing ? (
          <EditToken
            token={editing}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              tokens.reload();
            }}
          />
        ) : null}
        {created ? <NewToken created={created} publicUrl={publicUrl} onDone={() => setCreated(null)} /> : null}
        <CreateToken
          onCreated={(next) => {
            setCreated(next);
            tokens.reload();
          }}
        />
        {error || tokens.error ? <Alert color="red">{error ?? tokens.error}</Alert> : null}
        <Paper withBorder>
          <Table fz="sm" verticalSpacing={6}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Scope</Table.Th>
                <Table.Th>Reaches</Table.Th>
                <Table.Th>Token</Table.Th>
                <Table.Th>Acts as</Table.Th>
                <Table.Th>Last used</Table.Th>
                <Table.Th>Expires</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(tokens.data ?? []).map((token) => (
                <Table.Tr key={token.id}>
                  <Table.Td>
                    {token.name}
                    {token.kind === "oauth" ? (
                      <Badge size="xs" variant="outline" ml={6}>
                        connected app
                      </Badge>
                    ) : null}
                    {token.inactive ? (
                      <Text size="xs" c="orange">
                        {token.inactive}
                      </Text>
                    ) : null}
                  </Table.Td>
                  <Table.Td>
                    <Badge size="sm" variant="light" color={token.scope === "write" ? "orange" : "cyan"}>
                      {token.scope}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c={token.areas || token.namespaces ? undefined : "dimmed"}>
                      {limitsSummary(token)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Code>{token.prefix}…</Code>
                  </Table.Td>
                  <Table.Td>{token.createdBy}</Table.Td>
                  <Table.Td>{token.lastUsedAt ? relativeTime(token.lastUsedAt) : "never"}</Table.Td>
                  <Table.Td>{token.expiresAt ? relativeTime(token.expiresAt) : "never"}</Table.Td>
                  <Table.Td>
                    <Group gap={4} wrap="nowrap">
                      <Button size="compact-xs" variant="subtle" onClick={() => setEditing(token)}>
                        Edit
                      </Button>
                      <Button size="compact-xs" color="red" variant="subtle" onClick={() => void revoke(token.id)}>
                        Revoke
                      </Button>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          {tokens.data?.length === 0 ? (
            <Text size="sm" c="dimmed" p="md">
              No tokens yet.
            </Text>
          ) : null}
        </Paper>

        <Paper withBorder p="md">
          <Stack gap="xs">
            <Title order={5}>MCP server</Title>
            <Text size="sm">
              MCP clients connect to <Code>{publicUrl.replace(/\/+$/, "") + MCP_PATH}</Code> with a token as a bearer.
              From Claude Code:
            </Text>
            <Copyable value={claudeCommand(publicUrl)} />
            <Text size="sm" c="dimmed">
              {MCP_TOOLS.filter((t) => t.scope === "read").length} read tools; a write token adds{" "}
              {MCP_TOOLS.filter((t) => t.scope === "write").length} more:{" "}
              {MCP_TOOLS.filter((t) => t.scope === "write")
                .map((t) => t.name)
                .join(", ")}
              .
            </Text>
          </Stack>
        </Paper>
      </Stack>
    </>
  );
}

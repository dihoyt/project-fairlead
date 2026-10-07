import { useState, type FormEvent } from "react";
import {
  Alert,
  Badge,
  Button,
  Code,
  CopyButton,
  Drawer,
  Group,
  Paper,
  Radio,
  Select,
  Stack,
  Switch,
  Table,
  TagsInput,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import type { Role, UserChangesRequest, UserView } from "@contracts/auth";
import { apiRequest, useApi } from "../../ui/api";
import { useSession } from "../../ui/session";
import { relativeTime } from "../../ui/time";
import { hostOf } from "../account/AccountPage";
import { PageHeader } from "../PageHeader";

const ROLES: Role[] = ["user", "admin"];

function OneTimePassword({ password, onDone }: { password: string; onDone: () => void }) {
  return (
    <Alert color="teal" variant="light" withCloseButton onClose={onDone} title="Temporary password">
      <Group gap="xs">
        <Code fz="sm">{password}</Code>
        <CopyButton value={password}>
          {({ copied, copy }) => (
            <Button size="compact-xs" variant="subtle" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
        </CopyButton>
      </Group>
      <Text size="xs" mt={4}>
        Shown once. They will be asked to choose their own at first sign-in.
      </Text>
    </Alert>
  );
}

function CreateUser({ onCreated }: { onCreated: (password: string | null) => void }) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [password, setPassword] = useState<"generate" | "none">("generate");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await apiRequest("POST /api/admin/users", {
        // Omitted password: the server generates a temporary one. null: an
        // account for SSO sign-in only.
        body: { username, email: email || undefined, role, ...(password === "none" ? { password: null } : {}) },
      });
      setUsername("");
      setEmail("");
      onCreated(result.temporaryPassword);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper withBorder p="md">
      <form onSubmit={submit}>
        <Stack gap="xs">
          <Group align="flex-end" gap="xs" wrap="wrap">
            <TextInput
              label="Username"
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              required
              w={200}
            />
            <TextInput label="Email" value={email} onChange={(e) => setEmail(e.currentTarget.value)} w={240} />
            <Select
              label="Role"
              data={ROLES}
              value={role}
              onChange={(v) => setRole((v as Role | null) ?? "user")}
              w={110}
              allowDeselect={false}
            />
            <Button type="submit" loading={busy}>
              Add user
            </Button>
          </Group>
          <Radio.Group value={password} onChange={(v) => setPassword(v as "generate" | "none")}>
            <Group gap="md">
              <Radio value="generate" label="Give a temporary password" />
              <Radio value="none" label="SSO only (claimed at their first SSO sign-in with this username or email)" />
            </Group>
          </Radio.Group>
          {error ? (
            <Text size="xs" c="red">
              {error}
            </Text>
          ) : null}
        </Stack>
      </form>
    </Paper>
  );
}

function UserDrawer({
  user,
  onClose,
  onChanged,
}: {
  user: UserView;
  onClose: () => void;
  onChanged: (temporaryPassword?: string) => void;
}) {
  const { me } = useSession();
  // The platform's User.id is the username.
  const self = me.id === user.username;
  const id = String(user.id);
  const [networks, setNetworks] = useState(user.allowedNetworks);
  const sessions = useApi("GET /api/admin/users/:id/sessions", { params: { id } });
  const [error, setError] = useState<string | null>(null);

  const act = async (action: () => Promise<unknown>, after?: () => void) => {
    setError(null);
    try {
      await action();
      after?.();
      onChanged();
      sessions.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const patch = (body: UserChangesRequest) =>
    act(() => apiRequest("PATCH /api/admin/users/:id", { params: { id }, body }));

  return (
    <Drawer opened onClose={onClose} position="right" size="md" title={<Title order={4}>{user.username}</Title>}>
      <Stack gap="lg">
        {error ? <Alert color="red">{error}</Alert> : null}
        <Group>
          <Select
            label="Role"
            data={ROLES}
            value={user.role}
            onChange={(role) => role && role !== user.role && void patch({ role: role as Role })}
            allowDeselect={false}
            disabled={self}
            w={120}
          />
          <Switch
            mt={24}
            label="Disabled"
            checked={user.disabled}
            disabled={self}
            onChange={(e) => void patch({ disabled: e.currentTarget.checked })}
          />
        </Group>

        <Stack gap={4}>
          <TagsInput
            label="Trusted networks"
            description="Optional. Only these addresses or CIDR ranges may use this account. Empty follows the sign-in method's rule, which by default allows anywhere."
            value={networks}
            onChange={setNetworks}
            splitChars={[",", " "]}
            placeholder="e.g. 203.0.113.7 or 192.168.1.0/24"
            clearable
          />
          {JSON.stringify(networks) !== JSON.stringify(user.allowedNetworks) ? (
            <Group gap="xs">
              <Button size="xs" onClick={() => void patch({ allowedNetworks: networks })}>
                Save networks
              </Button>
              <Button size="xs" variant="subtle" onClick={() => setNetworks(user.allowedNetworks)}>
                Cancel
              </Button>
            </Group>
          ) : null}
        </Stack>

        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Linked SSO sign-ins
          </Text>
          {user.identities.length === 0 ? (
            <Text size="xs" c="dimmed">
              None.
            </Text>
          ) : null}
          {user.identities.map((identity) => (
            <Group key={`${identity.provider}|${identity.subject}`} justify="space-between">
              <Text size="xs">
                {identity.email || identity.subject}{" "}
                <Text span c="dimmed" size="xs">
                  via {hostOf(identity.provider)}
                </Text>
              </Text>
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                onClick={() =>
                  void act(() =>
                    apiRequest("DELETE /api/admin/users/:id/identities", {
                      params: { id },
                      body: { provider: identity.provider },
                    })
                  )
                }
              >
                Unlink
              </Button>
            </Group>
          ))}
        </Stack>

        <Stack gap={4}>
          <Group justify="space-between">
            <Text size="sm" fw={500}>
              Sessions
            </Text>
            {(sessions.data ?? []).length > 0 ? (
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                onClick={() => void act(() => apiRequest("DELETE /api/admin/users/:id/sessions", { params: { id } }))}
              >
                Sign out everywhere
              </Button>
            ) : null}
          </Group>
          {sessions.data && sessions.data.length === 0 ? (
            <Text size="xs" c="dimmed">
              No open sessions.
            </Text>
          ) : null}
          {(sessions.data ?? []).map((session) => (
            <Group key={session.id} justify="space-between" wrap="nowrap">
              <Text size="xs">
                {session.ip} · {session.method === "oidc" ? "SSO" : "password"} · {relativeTime(session.lastSeenAt)}
              </Text>
              <Button
                size="compact-xs"
                variant="subtle"
                onClick={() =>
                  void act(() =>
                    apiRequest("DELETE /api/admin/users/:id/sessions/:handle", {
                      params: { id, handle: session.id },
                    })
                  )
                }
              >
                End
              </Button>
            </Group>
          ))}
        </Stack>

        <Group>
          <Button
            variant="default"
            size="xs"
            onClick={() => {
              setError(null);
              apiRequest("POST /api/admin/users/:id/password", { params: { id } }).then(
                (result) => onChanged(result.temporaryPassword),
                (err: Error) => setError(err.message)
              );
            }}
          >
            Reset password
          </Button>
          {user.totpEnabled ? (
            <Button
              variant="default"
              size="xs"
              onClick={() => {
                if (
                  window.confirm(`Remove ${user.username}'s authenticator and recovery codes? Their sessions end too.`)
                ) {
                  void act(() => apiRequest("POST /api/admin/users/:id/totp/reset", { params: { id } }));
                }
              }}
            >
              Reset two-factor
            </Button>
          ) : null}
          {!self ? (
            <Button
              variant="subtle"
              color="red"
              size="xs"
              onClick={() => {
                if (window.confirm(`Delete ${user.username}?`)) {
                  void act(() => apiRequest("DELETE /api/admin/users/:id", { params: { id } }), onClose);
                }
              }}
            >
              Delete user
            </Button>
          ) : null}
        </Group>
      </Stack>
    </Drawer>
  );
}

export function UsersPage() {
  const users = useApi("GET /api/admin/users");
  const [openId, setOpenId] = useState<number | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const open = users.data?.find((user) => user.id === openId) ?? null;

  return (
    <>
      <PageHeader title="Users" description="Local accounts, their roles, networks and sessions." />
      <Stack gap="lg">
        {users.error ? <Alert color="red">{users.error}</Alert> : null}
        {password ? <OneTimePassword password={password} onDone={() => setPassword(null)} /> : null}
        <CreateUser
          onCreated={(temporary) => {
            setPassword(temporary);
            users.reload();
          }}
        />
        <Paper withBorder>
          <Table verticalSpacing="xs" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>User</Table.Th>
                <Table.Th>Role</Table.Th>
                <Table.Th>Sign-in</Table.Th>
                <Table.Th>2FA</Table.Th>
                <Table.Th>Networks</Table.Th>
                <Table.Th>Last sign-in</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(users.data ?? []).map((user) => (
                <Table.Tr key={user.id} onClick={() => setOpenId(user.id)} style={{ cursor: "pointer" }}>
                  <Table.Td>
                    <Text size="sm">{user.displayName || user.username}</Text>
                    <Text size="xs" c="dimmed">
                      {[user.displayName && user.username, user.email].filter(Boolean).join(" · ")}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4}>
                      <Badge size="xs" variant="light" color={user.role === "admin" ? "cyan" : "gray"}>
                        {user.role}
                      </Badge>
                      {user.disabled ? (
                        <Badge size="xs" color="red" variant="light">
                          disabled
                        </Badge>
                      ) : null}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">
                      {[user.hasPassword && "password", user.identities.length > 0 && "SSO"]
                        .filter(Boolean)
                        .join(" + ") || "-"}
                      {user.mustChangePassword ? " (temporary)" : ""}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {user.totpEnabled ? (
                      <Badge size="xs" variant="light" color="teal">
                        on
                      </Badge>
                    ) : (
                      <Text size="xs" c="dimmed">
                        -
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c={user.allowedNetworks.length ? undefined : "dimmed"}>
                      {user.allowedNetworks.length ? user.allowedNetworks.join(", ") : "anywhere"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      {relativeTime(user.lastLoginAt)}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Paper>
      </Stack>
      {open ? (
        <UserDrawer
          user={open}
          onClose={() => setOpenId(null)}
          onChanged={(temporary) => {
            if (temporary) setPassword(temporary);
            users.reload();
          }}
        />
      ) : null}
    </>
  );
}

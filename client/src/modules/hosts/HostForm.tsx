import { useState } from "react";
import {
  Alert,
  Button,
  Code,
  Group,
  NumberInput,
  PasswordInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import type { HostKind, HostRequest, HostTestResult, HostView } from "@contracts/hosts";
import { CheckList, apiRequest } from "../../ui";
import { GeneratedKey, useKeypair, type KeypairResource } from "./GeneratedKey";
import { KIND_LABEL } from "./labels";

type SignIn = "generated" | "key" | "password";

export const SIGN_IN_OPTIONS: Array<{ value: SignIn; label: string }> = [
  { value: "generated", label: "Generated key" },
  { value: "key", label: "Own key" },
  { value: "password", label: "Password" },
];

const KIND_OPTIONS = (Object.keys(KIND_LABEL) as HostKind[]).map((value) => ({ value, label: KIND_LABEL[value] }));

export function HostForm({
  host,
  keypair: sharedKeypair,
  onSubmit,
  onCancel,
}: {
  host?: HostView;
  keypair?: KeypairResource;
  onSubmit: (req: HostRequest) => Promise<void>;
  onCancel: () => void;
}) {
  const editing = host !== undefined;
  const [label, setLabel] = useState(host?.label ?? "");
  const [address, setAddress] = useState(host?.address ?? "");
  const [port, setPort] = useState<number>(host?.port ?? 22);
  const [username, setUsername] = useState(host?.username ?? "monitor");
  const [signIn, setSignIn] = useState<SignIn>(host ? (host.generatedKey ? "generated" : host.auth) : "generated");
  const keypair = useKeypair(sharedKeypair);
  const [credential, setCredential] = useState("");
  const [kind, setKind] = useState<HostKind>(host?.kind ?? "auto");
  const [paths, setPaths] = useState((host?.backupTargetPaths ?? []).join("\n"));
  const [fingerprint, setFingerprint] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [tested, setTested] = useState<HostTestResult>();

  function request(): HostRequest {
    return {
      label,
      address: address.trim(),
      port,
      username: username.trim(),
      auth: signIn === "password" ? "password" : "key",
      ...(signIn === "generated" ? { useGeneratedKey: true } : {}),
      kind,
      backupTargetPaths: paths
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean),
      ...(credential && signIn !== "generated" ? { credential } : {}),
      ...(fingerprint.trim() ? { hostKeyFingerprint: fingerprint.trim() } : {}),
    };
  }

  async function test() {
    setBusy("test");
    setError(undefined);
    setTested(undefined);
    try {
      const result = await apiRequest("POST /api/hosts/test", { body: request() });
      setTested(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    setBusy("save");
    setError(undefined);
    try {
      await onSubmit(request());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const keepHint =
    editing && host.hasCredential && !host.generatedKey && signIn === host.auth
      ? "Leave empty to keep the stored one."
      : undefined;

  return (
    <Stack>
      <TextInput label="Name" required value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
      <Group grow align="flex-start">
        <TextInput
          label="Address"
          description="Hostname or IP"
          required
          value={address}
          onChange={(e) => setAddress(e.currentTarget.value)}
        />
        <NumberInput
          label="Port"
          description="SSH"
          min={1}
          max={65535}
          value={port}
          onChange={(v) => setPort(Number(v) || 22)}
        />
      </Group>
      <Group grow align="flex-start">
        <TextInput
          label="User"
          description="A read-only account"
          required
          value={username}
          onChange={(e) => setUsername(e.currentTarget.value)}
        />
        <Select
          label="Kind"
          description="Detected when automatic"
          data={KIND_OPTIONS}
          value={kind}
          allowDeselect={false}
          onChange={(v) => setKind((v as HostKind) ?? "auto")}
        />
      </Group>
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Sign in with
        </Text>
        <SegmentedControl value={signIn} onChange={(v) => setSignIn(v as SignIn)} data={SIGN_IN_OPTIONS} />
      </Stack>
      {signIn === "generated" ? (
        <GeneratedKey resource={keypair} canGenerate />
      ) : signIn === "key" ? (
        <Textarea
          label="Private key"
          description={
            keepHint ?? "An unencrypted key used only for monitoring (ssh-keygen -t ed25519 -N ''). Stored encrypted."
          }
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          autosize
          minRows={3}
          maxRows={8}
          styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)", fontSize: 12 } }}
          value={credential}
          onChange={(e) => setCredential(e.currentTarget.value)}
        />
      ) : (
        <PasswordInput
          label="Password"
          description={keepHint ?? "Stored encrypted. A key is preferred."}
          value={credential}
          onChange={(e) => setCredential(e.currentTarget.value)}
        />
      )}
      <Textarea
        label="Backup target paths"
        description="Folders on this host that hold backups, one per line (e.g. /volume1/backups). Their free space is shown on the backup page."
        autosize
        minRows={1}
        maxRows={4}
        value={paths}
        onChange={(e) => setPaths(e.currentTarget.value)}
      />
      <TextInput
        label="Host key fingerprint"
        description={
          editing
            ? "Leave empty to keep the pinned key. Set it to trust a new key after a reinstall."
            : "Optional. Pinned automatically on the first connection when empty."
        }
        placeholder="SHA256:…"
        value={fingerprint}
        onChange={(e) => setFingerprint(e.currentTarget.value)}
      />

      {tested && (
        <Alert
          color={tested.ok ? "teal" : "red"}
          variant="light"
          title={
            tested.ok
              ? `Connected${tested.detectedKind ? `: ${KIND_LABEL[tested.detectedKind]}` : ""}`
              : "Could not connect"
          }
        >
          <Stack gap="xs">
            {tested.hostKeyFingerprint && (
              <Group gap="xs">
                <Text size="sm">Host key</Text>
                <Code>{tested.hostKeyFingerprint}</Code>
                {tested.hostKeyFingerprint !== fingerprint.trim() && (
                  <Button
                    size="compact-xs"
                    variant="light"
                    onClick={() => setFingerprint(tested.hostKeyFingerprint ?? "")}
                  >
                    Trust this key
                  </Button>
                )}
              </Group>
            )}
            <CheckList results={tested.results} />
          </Stack>
        </Alert>
      )}
      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      <Group justify="space-between">
        <Button variant="light" loading={busy === "test"} disabled={busy !== null} onClick={() => void test()}>
          Test connection
        </Button>
        <Group>
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button loading={busy === "save"} disabled={busy !== null} onClick={() => void submit()}>
            {editing ? "Save" : "Add host"}
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}

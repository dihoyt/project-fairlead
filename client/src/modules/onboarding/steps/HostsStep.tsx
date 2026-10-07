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
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import type { HostKind, HostRequest, HostTestResult } from "@contracts/hosts";
import { CheckList, StatusBadge, apiRequest, useApi } from "../../../ui";
import { StepFrame, useAction, type StepProps } from "../shared";

const KINDS: Array<{ value: HostKind; label: string }> = [
  { value: "auto", label: "Detect" },
  { value: "linux", label: "Linux" },
  { value: "synology", label: "Synology DSM" },
  { value: "truenas", label: "TrueNAS SCALE" },
];

export function HostsStep({ onFinish }: StepProps) {
  const hosts = useApi("GET /api/hosts");
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [port, setPort] = useState<number>(22);
  const [username, setUsername] = useState("");
  const [auth, setAuth] = useState<"key" | "password">("key");
  const [credential, setCredential] = useState("");
  const [kind, setKind] = useState<HostKind>("auto");
  const [paths, setPaths] = useState("");
  const [tested, setTested] = useState<HostTestResult>();
  const action = useAction();

  const request = (): HostRequest => ({
    label: label.trim() || address.trim(),
    address: address.trim(),
    port,
    username: username.trim(),
    auth,
    kind,
    credential,
    backupTargetPaths: paths
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean),
    ...(tested?.hostKeyFingerprint ? { hostKeyFingerprint: tested.hostKeyFingerprint } : {}),
  });

  async function test() {
    setTested(undefined);
    const result = await action.run(() =>
      apiRequest("POST /api/hosts/test", { body: { ...request(), hostKeyFingerprint: undefined } })
    );
    if (result) setTested(result);
  }

  async function add() {
    const created = await action.run(() => apiRequest("POST /api/hosts", { body: request() }));
    if (!created) return;
    setLabel("");
    setAddress("");
    setCredential("");
    setPaths("");
    setTested(undefined);
    hosts.reload();
  }

  const list = hosts.data ?? [];

  return (
    <StepFrame
      onFinish={onFinish}
      intro="A NAS or Linux box to watch over SSH: disks, load, memory, and the free space where backups land. Use a read-only account; commands come from fixed templates, never from input."
      fullPage={{ to: "/hosts", label: "Hosts page" }}
      canFinish={list.length > 0}
    >
      {list.length ? (
        <Stack gap={4}>
          {list.map((host) => (
            <Group key={host.id} gap="xs">
              <StatusBadge status={host.status} />
              <Text size="sm">
                {host.label} <Code>{`${host.username}@${host.address}:${host.port}`}</Code>
              </Text>
            </Group>
          ))}
        </Stack>
      ) : null}
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput
          label="Address"
          placeholder="nas.example.lan"
          value={address}
          onChange={(e) => setAddress(e.currentTarget.value)}
        />
        <TextInput label="Name" placeholder="NAS" value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
        <TextInput label="Username" value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
        <NumberInput label="Port" min={1} max={65535} value={port} onChange={(v) => setPort(Number(v) || 22)} />
        <Select
          label="Kind"
          data={KINDS}
          value={kind}
          allowDeselect={false}
          onChange={(v) => setKind((v as HostKind) ?? "auto")}
        />
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Sign in with
          </Text>
          <SegmentedControl
            value={auth}
            onChange={(v) => setAuth(v as "key" | "password")}
            data={[
              { value: "key", label: "Private key" },
              { value: "password", label: "Password" },
            ]}
          />
        </Stack>
      </SimpleGrid>
      {auth === "key" ? (
        <Textarea
          label="Private key"
          description="OpenSSH or PEM. Stored encrypted."
          autosize
          minRows={3}
          value={credential}
          onChange={(e) => setCredential(e.currentTarget.value)}
        />
      ) : (
        <PasswordInput
          label="Password"
          description="Stored encrypted."
          value={credential}
          onChange={(e) => setCredential(e.currentTarget.value)}
        />
      )}
      <Textarea
        label="Backup folders"
        description="Optional, one per line (e.g. /volume1/backups); their free space shows on the backup page."
        autosize
        minRows={1}
        value={paths}
        onChange={(e) => setPaths(e.currentTarget.value)}
      />
      {action.error ? <Alert color="red">{action.error}</Alert> : null}
      {tested ? (
        <Alert color={tested.ok ? "green" : "red"} title={tested.ok ? "Connected" : "Could not connect"}>
          <Stack gap="xs">
            {tested.error ? <Text size="sm">{tested.error}</Text> : null}
            {tested.hostKeyFingerprint ? (
              <Text size="sm">
                Host key <Code>{tested.hostKeyFingerprint}</Code> will be pinned. Compare it with the host before
                adding.
              </Text>
            ) : null}
            {tested.results.length ? <CheckList results={tested.results} /> : null}
          </Stack>
        </Alert>
      ) : null}
      <Group>
        <Button variant="default" loading={action.busy} disabled={!address || !username || !credential} onClick={test}>
          Test connection
        </Button>
        <Button loading={action.busy} disabled={!tested?.ok} onClick={add}>
          Add host
        </Button>
      </Group>
    </StepFrame>
  );
}

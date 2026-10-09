import { useState } from "react";
import { Alert, Badge, Button, Card, Code, Group, Modal, PasswordInput, Stack, Text, TextInput } from "@mantine/core";
import { IconDownload } from "@tabler/icons-react";
import type { ConsoleBackupView } from "@contracts/backups";
import type { Me } from "@contracts/auth";
import { formatBytes } from "@contracts/disk";
import { apiRequest, useApi } from "../../ui";
import { DeployJobProgress } from "../../ui/deploy";
import { absoluteTime, relativeTime } from "../../ui";

const MIN_PASSPHRASE = 12;
const CRITICAL = "critical";

const STORAGE: Record<ConsoleBackupView["storage"], string> = {
  longhorn: "Longhorn",
  "local-path": "local-path (one node's disk)",
  other: "its storage class",
  none: "no lasting volume",
};

// "This console": the console's own database volume, its nightly copy to a
// storage target, and the recovery kit that opens the copy's secrets.
export function ConsoleBackupCard({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const view = useApi("GET /api/backups/console");
  const [job, setJob] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kitOpen, setKitOpen] = useState(false);
  const data = view.data;
  if (!data) return null;

  const run = async (start: () => Promise<{ id: string }>) => {
    setBusy(true);
    setError(null);
    try {
      setJob((await start()).id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const finished = () => {
    view.reload();
    onChanged();
  };
  const nightly = data.nightly;
  const inCritical = data.groups?.includes(CRITICAL) ?? false;

  return (
    <Card withBorder padding="sm" data-console-backup={data.storage}>
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
          <Stack gap={4}>
            <Text fw={600}>This console</Text>
            <Text size="sm">
              {data.claim ? (
                <>
                  Its database is on {data.claim.namespace}/{data.claim.name}, {STORAGE[data.storage]}
                  {data.storageClass && data.storage === "other" ? ` (${data.storageClass})` : ""}.
                </>
              ) : (
                "Its database is on no lasting volume here, so there is nothing to back up."
              )}
            </Text>
            {data.storage === "longhorn" ? (
              <Text size="sm">
                Longhorn backs the volume up with its group{(data.groups?.length ?? 0) > 1 ? "s" : ""}{" "}
                {(data.groups ?? []).join(", ") || "default"}
                {data.lastVolumeBackupAt ? `; last backup ${relativeTime(data.lastVolumeBackupAt)}` : "; no backup yet"}
                .
              </Text>
            ) : null}
            <NightlyLine view={data} />
          </Stack>
          {me.admin ? (
            <Group gap="xs">
              {data.storage === "longhorn" && data.claim && !inCritical ? (
                <Button
                  size="xs"
                  variant="default"
                  loading={busy}
                  onClick={() =>
                    void run(() =>
                      apiRequest("PUT /api/backups/volumes/:uid/groups", {
                        params: { uid: data.claim!.uid },
                        body: { groups: [...(data.groups ?? ["default"]), CRITICAL] },
                      })
                    )
                  }
                >
                  Add to the critical group
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="default"
                loading={busy}
                disabled={!!nightly.blockedBy}
                onClick={() => void run(() => apiRequest("POST /api/backups/console/backup-now"))}
              >
                Back up now
              </Button>
              {data.secretsKey ? (
                <Button size="xs" leftSection={<IconDownload size={14} />} onClick={() => setKitOpen(true)}>
                  Download recovery kit
                </Button>
              ) : null}
            </Group>
          ) : null}
        </Group>
        {error ? <Alert color="red">{error}</Alert> : null}
        {job ? <DeployJobProgress jobId={job} onFinished={finished} /> : null}
        <Text size="xs" c="dimmed">
          {data.secretsKey
            ? "A copy of the database restores without the recovery kit, but every stored secret (connector tokens, passwords) then reads as missing. Keep the kit somewhere apart from the cluster."
            : "SECRETS_KEY is not set, so no secrets are stored and a copy of the database restores on its own."}
        </Text>
        <Text size="xs" c="dimmed">
          To reinstall from a copy: <Code>{data.restoreCommand}</Code>
        </Text>
      </Stack>
      <Modal opened={kitOpen} onClose={() => setKitOpen(false)} title="Download recovery kit">
        {kitOpen ? <RecoveryKitDialog me={me} onDone={() => setKitOpen(false)} /> : null}
      </Modal>
    </Card>
  );
}

function NightlyLine({ view }: { view: ConsoleBackupView }) {
  const n = view.nightly;
  if (n.blockedBy) {
    return (
      <Text size="sm">
        <Badge color="yellow" variant="light" mr={6}>
          no nightly copy
        </Badge>
        {n.blockedBy}
      </Text>
    );
  }
  if (!n.schedule) return <Text size="sm">The nightly copy is off (deploy.consoleBackup is empty).</Text>;
  const last = n.last;
  return (
    <Stack gap={2}>
      <Text size="sm">
        A copy of the database goes to {n.target?.name ?? "the storage target"} on <Code>{n.schedule}</Code> (UTC),{" "}
        {n.keep} kept{n.nextAt ? `; next ${absoluteTime(n.nextAt)}` : ""}.
      </Text>
      {n.lastGood ? (
        <Text size="sm">
          Newest copy: {n.lastGood.file}
          {n.lastGood.sizeBytes !== undefined ? ` (${formatBytes(n.lastGood.sizeBytes)})` : ""},{" "}
          {relativeTime(n.lastGood.at)}.
        </Text>
      ) : (
        <Text size="sm">No copy has been made yet.</Text>
      )}
      {last && last.state === "failed" ? (
        <Text size="sm" c="red">
          The last run failed: {last.message ?? "see Apps → Installed → recent deploys"}
        </Text>
      ) : null}
    </Stack>
  );
}

export function RecoveryKitDialog({ me, onDone }: { me: Me; onDone: () => void }) {
  const totp = useApi("GET /api/auth/totp/status");
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needsPassword = me.source === "password";
  const needsCode = needsPassword && totp.data?.enabled === true;
  const problem =
    passphrase.length < MIN_PASSPHRASE
      ? `At least ${MIN_PASSPHRASE} characters.`
      : passphrase !== again
        ? "The two passphrases differ."
        : null;

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const kit = await apiRequest("POST /api/admin/recovery-kit", {
        body: { passphrase, ...(needsPassword ? { password } : {}), ...(needsCode ? { code } : {}) },
      });
      const url = URL.createObjectURL(new Blob([kit], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "recovery-kit.txt";
      a.click();
      URL.revokeObjectURL(url);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="sm">
      <Text size="sm">
        The kit holds the key that opens this install's stored secrets, sealed with a passphrase you choose now. Keep
        the passphrase apart from the file: without both, a restored database has no secrets.
      </Text>
      <PasswordInput
        label="Passphrase"
        value={passphrase}
        onChange={(e) => setPassphrase(e.currentTarget.value)}
        error={passphrase && problem?.startsWith("At least") ? problem : undefined}
      />
      <PasswordInput
        label="Passphrase again"
        value={again}
        onChange={(e) => setAgain(e.currentTarget.value)}
        error={again && passphrase !== again ? "The two passphrases differ." : undefined}
      />
      {needsPassword ? (
        <PasswordInput
          label="Your password"
          description="To confirm it is you."
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
      ) : me.source === "oidc" ? (
        <Text size="xs" c="dimmed">
          Your sign-in must be from the last 15 minutes; sign out and in again if it is older.
        </Text>
      ) : null}
      {needsCode ? (
        <TextInput label="Authenticator code" value={code} onChange={(e) => setCode(e.currentTarget.value)} />
      ) : null}
      {error ? <Alert color="red">{error}</Alert> : null}
      <Group justify="flex-end">
        <Button
          onClick={() => void download()}
          loading={busy}
          disabled={!!problem || (needsPassword && !password) || (needsCode && !code)}
        >
          Download
        </Button>
      </Group>
    </Stack>
  );
}

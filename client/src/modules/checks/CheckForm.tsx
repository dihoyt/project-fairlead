import { useState } from "react";
import {
  Alert,
  Button,
  Collapse,
  Group,
  NumberInput,
  PasswordInput,
  SegmentedControl,
  Stack,
  Switch,
  TagsInput,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { IconAlertTriangle, IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import type { CheckKind, CheckRequest, CheckView } from "@contracts/checks";

const SECOND = 1000;

export function CheckForm({
  check,
  onSubmit,
  onCancel,
}: {
  check?: CheckView;
  onSubmit: (req: CheckRequest) => Promise<void>;
  onCancel: () => void;
}) {
  const editing = check !== undefined;
  const [kind, setKind] = useState<CheckKind>(check?.kind ?? "http");
  const [label, setLabel] = useState(check?.label ?? "");
  const [target, setTarget] = useState(check?.target ?? "");
  const [intervalS, setIntervalS] = useState<number>((check?.intervalMs ?? 60_000) / SECOND);
  const [timeoutS, setTimeoutS] = useState<number>((check?.timeoutMs ?? 10_000) / SECOND);
  const [expectStatus, setExpectStatus] = useState<string[]>((check?.expectStatus ?? []).map(String));
  const [bodyMatch, setBodyMatch] = useState(check?.bodyMatch ?? "");
  const [authHeader, setAuthHeader] = useState(check?.authHeader ?? "");
  const [secret, setSecret] = useState("");
  const [tlsWarnDays, setTlsWarnDays] = useState<number>(check?.tlsWarnDays ?? 21);
  const [insecure, setInsecure] = useState(check?.insecureSkipVerify ?? false);
  const [enabled, setEnabled] = useState(check?.enabled ?? true);
  const [advanced, setAdvanced] = useState(
    Boolean(check?.expectStatus?.length || check?.bodyMatch || check?.authHeader || check?.insecureSkipVerify)
  );
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const http = kind === "http";
  const https = http && target.trim().toLowerCase().startsWith("https:");
  const storedSecret = editing && check.hasSecret;

  async function submit() {
    const req: CheckRequest = {
      label,
      kind,
      target,
      intervalMs: Math.round(intervalS * SECOND),
      timeoutMs: Math.round(timeoutS * SECOND),
      enabled,
    };
    if (http) {
      const codes = expectStatus.map(Number).filter((n) => Number.isInteger(n));
      if (codes.length) req.expectStatus = codes;
      if (bodyMatch) req.bodyMatch = bodyMatch;
      if (authHeader.trim()) {
        req.authHeader = authHeader.trim();
        if (secret) req.secret = secret;
      }
      req.insecureSkipVerify = https && insecure;
      req.tlsWarnDays = tlsWarnDays;
    }
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit(req);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack>
      <SegmentedControl
        value={kind}
        onChange={(value) => setKind(value as CheckKind)}
        data={[
          { value: "http", label: "HTTP(S)" },
          { value: "tcp", label: "TCP" },
        ]}
      />
      <TextInput label="Name" required value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
      <TextInput
        label={http ? "URL" : "Host and port"}
        required
        placeholder={http ? "https://grafana.example.com/api/health" : "nas.lan:445"}
        description={http ? "Fetched with GET; redirects are not followed and count as up." : undefined}
        value={target}
        onChange={(e) => setTarget(e.currentTarget.value)}
      />
      <Group grow>
        <NumberInput
          label="Every (seconds)"
          min={15}
          max={86_400}
          value={intervalS}
          onChange={(v) => setIntervalS(Number(v) || 60)}
        />
        <NumberInput
          label="Timeout (seconds)"
          min={0.5}
          max={12}
          step={0.5}
          decimalScale={1}
          value={timeoutS}
          onChange={(v) => setTimeoutS(Number(v) || 10)}
        />
      </Group>
      {http && (
        <>
          <UnstyledButton onClick={() => setAdvanced((a) => !a)}>
            <Group gap={4}>
              {advanced ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
              <Text size="sm">Response, authentication and TLS</Text>
            </Group>
          </UnstyledButton>
          <Collapse expanded={advanced}>
            <Stack>
              <TagsInput
                label="Expected status codes"
                description="Empty: any 2xx or 3xx."
                placeholder="200, 401"
                value={expectStatus}
                onChange={(values) => setExpectStatus(values.filter((v) => /^\d{3}$/.test(v)))}
                splitChars={[",", " "]}
              />
              <TextInput
                label="Body must contain"
                description="Plain text, case-sensitive; not a pattern."
                placeholder='"status":"ok"'
                value={bodyMatch}
                onChange={(e) => setBodyMatch(e.currentTarget.value)}
              />
              <Group grow align="flex-start">
                <TextInput
                  label="Auth header"
                  placeholder="Authorization"
                  value={authHeader}
                  onChange={(e) => setAuthHeader(e.currentTarget.value)}
                />
                <PasswordInput
                  label="Header value"
                  description={storedSecret ? "Leave empty to keep the stored value." : "Stored encrypted."}
                  placeholder={storedSecret ? "•••••• stored" : "Bearer …"}
                  disabled={!authHeader.trim()}
                  value={secret}
                  onChange={(e) => setSecret(e.currentTarget.value)}
                />
              </Group>
              {storedSecret && !authHeader.trim() && (
                <Text size="xs" c="dimmed">
                  Saving without an auth header removes the stored value.
                </Text>
              )}
              <NumberInput
                label="Warn when the certificate expires within (days)"
                description="Critical at a third of this. 0 turns it off."
                min={0}
                max={365}
                disabled={!https}
                value={tlsWarnDays}
                onChange={(v) => setTlsWarnDays(Number(v) || 0)}
              />
              <Switch
                label="Accept an unverified certificate"
                description="For self-signed targets. The connection is still encrypted but not authenticated."
                color="orange"
                disabled={!https}
                checked={https && insecure}
                onChange={(e) => setInsecure(e.currentTarget.checked)}
                thumbIcon={insecure ? <IconAlertTriangle size={10} /> : undefined}
              />
            </Stack>
          </Collapse>
        </>
      )}
      <Switch label="Enabled" checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}
      <Group justify="flex-end">
        <Button variant="default" onClick={onCancel}>
          Cancel
        </Button>
        <Button loading={busy} onClick={() => void submit()}>
          {editing ? "Save" : "Add check"}
        </Button>
      </Group>
    </Stack>
  );
}

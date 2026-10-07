import { useState, type FormEvent } from "react";
import { Alert, Badge, Button, Group, PasswordInput, Stack, Text, TextInput, Title } from "@mantine/core";
import { apiRequest, useApi } from "../../ui/api";
import { useSession } from "../../ui/session";
import { TotpEnrollForm } from "../auth/TotpEnrollForm";
import { TotpRecoveryCodes } from "../auth/TotpRecoveryCodes";

type Mode = "idle" | "enrol" | "disable" | "regenerate";

// Only password sessions see this: an SSO sign-in's second factor is the
// identity provider's business.
export function TwoFactorSection() {
  const { me } = useSession();
  const status = useApi("GET /api/auth/totp/status", undefined, { enabled: me.source === "password" });
  const [mode, setMode] = useState<Mode>("idle");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totp = status.data;
  if (me.source !== "password" || totp === null || (!totp.available && !totp.enabled)) return null;

  const reset = () => {
    setMode("idle");
    setInput("");
    setError(null);
    setBusy(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "disable") {
        await apiRequest("POST /api/auth/totp/disable", { body: { password: input } });
      } else {
        const result = await apiRequest("POST /api/auth/totp/recovery-codes", { body: { code: input } });
        setCodes(result.recoveryCodes);
      }
      reset();
      status.reload();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Stack gap="xs">
      <Group gap="xs">
        <Title order={4}>Two-factor sign-in</Title>
        <Badge size="xs" variant="light" color={totp.enabled ? "teal" : "gray"}>
          {totp.enabled ? "on" : "off"}
        </Badge>
        {totp.required ? (
          <Badge size="xs" variant="light" color="yellow">
            required
          </Badge>
        ) : null}
      </Group>

      {codes !== null ? <TotpRecoveryCodes codes={codes} onDone={() => setCodes(null)} /> : null}

      {codes === null && mode === "enrol" ? (
        <TotpEnrollForm
          onEnrolled={(fresh) => {
            setCodes(fresh);
            reset();
            status.reload();
          }}
          onCancel={reset}
        />
      ) : null}

      {codes === null && mode === "idle" && !totp.enabled ? (
        <Group>
          <Text size="sm" c="dimmed">
            Ask for a code from an authenticator app at each password sign-in.
          </Text>
          <Button size="xs" variant="default" onClick={() => setMode("enrol")}>
            Set up
          </Button>
        </Group>
      ) : null}

      {codes === null && mode === "idle" && totp.enabled ? (
        <Group>
          <Text size="sm" c={totp.recoveryCodesLeft < 3 ? "yellow" : "dimmed"}>
            {totp.recoveryCodesLeft} recovery code{totp.recoveryCodesLeft === 1 ? "" : "s"} left.
          </Text>
          <Button size="xs" variant="default" onClick={() => setMode("regenerate")}>
            New recovery codes
          </Button>
          {!totp.required ? (
            <Button size="xs" variant="subtle" color="red" onClick={() => setMode("disable")}>
              Turn off
            </Button>
          ) : null}
        </Group>
      ) : null}

      {mode === "disable" || mode === "regenerate" ? (
        <form onSubmit={submit}>
          <Stack gap="xs" maw={420}>
            {error ? (
              <Alert color="red" variant="light">
                {error}
              </Alert>
            ) : null}
            {mode === "disable" ? (
              <PasswordInput
                label="Your password"
                autoComplete="current-password"
                value={input}
                onChange={(e) => setInput(e.currentTarget.value)}
                required
                autoFocus
              />
            ) : (
              <TextInput
                label="A code from your authenticator app"
                description="The old recovery codes stop working."
                inputMode="numeric"
                autoComplete="one-time-code"
                value={input}
                onChange={(e) => setInput(e.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
                required
                autoFocus
              />
            )}
            <Group justify="flex-end">
              <Button size="xs" variant="subtle" onClick={reset}>
                Cancel
              </Button>
              <Button size="xs" type="submit" loading={busy} color={mode === "disable" ? "red" : undefined}>
                {mode === "disable" ? "Turn off two-factor" : "Make new codes"}
              </Button>
            </Group>
          </Stack>
        </form>
      ) : null}
    </Stack>
  );
}

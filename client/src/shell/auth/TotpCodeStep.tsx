import { useState, type FormEvent } from "react";
import { Alert, Anchor, Button, Stack, Text, TextInput } from "@mantine/core";
import { ApiError, apiRequest } from "../../ui/api";

interface Props {
  pending: string;
  onSignedIn: () => void;
  // The pending token expired or the account changed under it; the
  // password has to be entered again.
  onRestart: (reason: string) => void;
}

export function TotpCodeStep({ pending, onSignedIn, onRestart }: Props) {
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiRequest("POST /api/auth/totp/verify", {
        body: recovery ? { pending, recoveryCode: code } : { pending, code },
      });
      onSignedIn();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && /expired/i.test(err.message)) {
        onRestart(err.message);
        return;
      }
      setError((err as Error).message);
      setCode("");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <Stack gap="sm">
        <Text size="sm">
          {recovery
            ? "Enter one of the recovery codes you saved."
            : "Enter the six-digit code from your authenticator app."}
        </Text>
        {error ? (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        ) : null}
        <TextInput
          key={recovery ? "recovery" : "code"}
          label={recovery ? "Recovery code" : "Code"}
          value={code}
          onChange={(e) => {
            const next = e.currentTarget.value;
            setCode(recovery ? next.trim().slice(0, 32) : next.replace(/\D/g, "").slice(0, 6));
          }}
          inputMode={recovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          placeholder={recovery ? "xxxx-xxxx" : "123456"}
          required
          autoFocus
        />
        <Button type="submit" loading={busy} disabled={recovery ? code.length === 0 : code.length !== 6}>
          Verify
        </Button>
        <Anchor
          component="button"
          type="button"
          size="xs"
          onClick={() => {
            setRecovery(!recovery);
            setCode("");
            setError(null);
          }}
        >
          {recovery ? "Use a code from the app instead" : "Use a recovery code"}
        </Anchor>
      </Stack>
    </form>
  );
}

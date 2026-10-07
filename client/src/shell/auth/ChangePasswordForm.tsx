import { useState, type FormEvent } from "react";
import { Alert, Button, PasswordInput, Stack } from "@mantine/core";
import { apiRequest } from "../../ui/api";

interface Props {
  // An account made for OIDC has no password yet, so there is nothing to
  // confirm before setting one.
  needsCurrent: boolean;
  submitLabel?: string;
  onChanged: () => void;
}

export function ChangePasswordForm({ needsCurrent, submitLabel = "Change password", onChanged }: Props) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (next !== confirm) {
      setError("The new passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiRequest("POST /api/auth/password", { body: { current, next } });
      setCurrent("");
      setNext("");
      setConfirm("");
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <Stack gap="sm">
        {error ? (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        ) : null}
        {needsCurrent ? (
          <PasswordInput
            label="Current password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.currentTarget.value)}
            required
          />
        ) : null}
        <PasswordInput
          label="New password"
          description="At least 10 characters."
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.currentTarget.value)}
          required
        />
        <PasswordInput
          label="Confirm new password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.currentTarget.value)}
          required
        />
        <Button type="submit" loading={busy}>
          {submitLabel}
        </Button>
      </Stack>
    </form>
  );
}

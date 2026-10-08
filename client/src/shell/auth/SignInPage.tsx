import { useState, type FormEvent } from "react";
import { Alert, Button, Divider, PasswordInput, Stack, Text, TextInput } from "@mantine/core";
import type { AuthMethods } from "@contracts/auth";
import { apiRequest, pageUrl } from "../../ui/api";
import { AuthCard } from "./AuthCard";
import { TotpCodeStep } from "./TotpCodeStep";

interface Props {
  methods: AuthMethods | null;
  reason: string | null;
  onSignedIn: () => void;
}

// A failed OIDC sign-in comes back as a redirect with the reason in the
// fragment, since the provider's round trip leaves no other channel. Read
// once and cleared, so a reload does not show it again.
function takeRedirectError(): string | null {
  const match = /(?:^#|[&?])signin-error=([^&]*)/.exec(window.location.hash);
  if (!match) return null;
  history.replaceState(null, "", window.location.pathname + window.location.search);
  return decodeURIComponent(match[1]!);
}

// Signing in through the provider leaves the page, so the route the
// browser was on (an MCP client's consent request, say) goes along.
export function oidcStartUrl(hash: string): string {
  return hash.startsWith("#/") && hash !== "#/"
    ? pageUrl(`auth/oidc/start?rd=${encodeURIComponent(`/${hash}`)}`)
    : pageUrl("auth/oidc/start");
}

export function SignInPage({ methods, reason, onSignedIn }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => takeRedirectError() ?? reason);
  const [pending, setPending] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await apiRequest("POST /api/auth/login", { body: { username, password } });
      if ("totpRequired" in result) {
        setPending(result.pending);
        setPassword("");
        setBusy(false);
        return;
      }
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const noMethod = methods !== null && !methods.password && methods.oidc === null;

  return (
    <AuthCard siteName={methods?.siteName}>
      {error ? (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      ) : null}
      {methods === null ? <Alert color="yellow">Could not reach the server.</Alert> : null}
      {noMethod ? (
        <Alert color="yellow">No sign-in method is turned on. An operator can restore one with reset-admin.</Alert>
      ) : null}
      {pending !== null ? (
        <TotpCodeStep
          pending={pending}
          onSignedIn={onSignedIn}
          onRestart={(why) => {
            setPending(null);
            setError(why);
          }}
        />
      ) : null}
      {pending === null && methods?.oidc ? (
        <Button component="a" href={oidcStartUrl(window.location.hash)} variant="filled">
          {methods.oidc.label}
        </Button>
      ) : null}
      {pending === null && methods?.oidc && methods.password ? <Divider label="or" labelPosition="center" /> : null}
      {pending === null && methods?.password ? (
        <form onSubmit={submit}>
          <Stack gap="sm">
            <TextInput
              label="Username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              required
              autoFocus
            />
            <PasswordInput
              label="Password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              required
            />
            <Button type="submit" loading={busy} variant={methods.oidc ? "default" : "filled"}>
              Sign in
            </Button>
          </Stack>
        </form>
      ) : null}
      {methods ? (
        <Text size="xs" c="dimmed">
          Connecting from {methods.ip}
        </Text>
      ) : null}
    </AuthCard>
  );
}

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Center, Loader } from "@mantine/core";
import type { AuthMethods, Me } from "@contracts/auth";
import { AUTH_CHANGED, ApiError, apiRequest } from "../../ui/api";
import { SessionContext, type Session } from "../../ui/session";
import { ChangePasswordPage } from "./ChangePasswordPage";
import { SignInPage } from "./SignInPage";
import { TotpEnrollPage } from "./TotpEnrollPage";

type State =
  | { kind: "loading" }
  | { kind: "signed-out"; methods: AuthMethods | null; reason: string | null }
  | { kind: "signed-in"; me: Me; methods: AuthMethods | null };

// Decides between the sign-in page, the forced password change, the forced
// two-factor enrolment and the app, from /api/me, and decides again
// whenever any request reports that the session changed under it.
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  const refresh = useCallback(async () => {
    const methods = await apiRequest("GET /api/auth/methods").catch(() => null);
    try {
      const me = await apiRequest("GET /api/me");
      setState({ kind: "signed-in", me, methods });
    } catch (err) {
      // "Not signed in." is the ordinary signed-out state and an unreachable
      // server is already reported; anything else (a network that isn't
      // trusted, a disabled account) is the reason to show.
      const ordinary = !(err instanceof ApiError) || err.status === 0 || err.message === "Not signed in.";
      const reason = ordinary ? null : (err as Error).message;
      setState({ kind: "signed-out", methods, reason });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(AUTH_CHANGED, onChange);
    return () => window.removeEventListener(AUTH_CHANGED, onChange);
  }, [refresh]);

  const session = useMemo<Session | null>(
    () => (state.kind === "signed-in" ? { me: state.me, methods: state.methods, refresh: () => void refresh() } : null),
    [state, refresh]
  );

  if (state.kind === "loading") {
    return (
      <Center h="100vh">
        <Loader size="sm" />
      </Center>
    );
  }
  if (state.kind === "signed-out") {
    return <SignInPage methods={state.methods} reason={state.reason} onSignedIn={() => void refresh()} />;
  }
  const siteName = state.methods?.siteName;
  if (state.me.mustChangePassword) {
    return <ChangePasswordPage siteName={siteName} onChanged={() => void refresh()} />;
  }
  if (state.me.mustEnrollTotp) {
    return <TotpEnrollPage siteName={siteName} onDone={() => void refresh()} />;
  }
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

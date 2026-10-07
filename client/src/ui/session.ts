import { createContext, useContext } from "react";
import type { AuthMethods, Me } from "@contracts/auth";

export interface Session {
  me: Me;
  methods: AuthMethods | null;
  // Re-asks the server who is signed in (after sign-out, a password change).
  refresh: () => void;
}

export const SessionContext = createContext<Session | null>(null);

// Everything under the shell renders only once the caller is known, so a
// page never sees a loading or signed-out state here.
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === null) throw new Error("useSession outside the signed-in shell");
  return session;
}

import { apiRequest } from "../../ui/api";

// Refreshes whatever the outcome: a failed logout still leaves the gate to
// decide from /api/me what the browser's session actually is.
export function signOut(then: () => void): void {
  void apiRequest("POST /api/auth/logout")
    .catch(() => undefined)
    .finally(then);
}

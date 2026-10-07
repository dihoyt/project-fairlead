import type { SignInMethod } from "../../contracts/platform.js";
import { inAny, parseCidrList } from "../net.js";
import type { PlatformSettings } from "../settings.js";
import type { UserRow } from "./users.js";

// Trusted networks are opt-in at every level. A user's own list wins when
// it has one; otherwise the sign-in method's list applies when an admin
// set one; otherwise anywhere is allowed. An empty list at a level means
// "no rule here", never "nowhere", so clearing a field can only ever widen
// access back to the default.

export interface NetworkRule {
  networks: string[];
  from: "user" | "method" | "none";
}

export function methodNetworksKey(method: SignInMethod): string {
  return method === "password" ? "auth.password.networks" : "auth.oidc.networks";
}

export function effectiveRule(
  settings: PlatformSettings,
  user: Pick<UserRow, "allowedNetworks">,
  method: SignInMethod
): NetworkRule {
  if (user.allowedNetworks.length > 0) return { networks: user.allowedNetworks, from: "user" };
  const byMethod = settings.list(methodNetworksKey(method));
  if (byMethod.length > 0) return { networks: byMethod, from: "method" };
  return { networks: [], from: "none" };
}

export function ruleAllows(rule: NetworkRule, ip: string): boolean {
  if (rule.from === "none") return true;
  try {
    return inAny(parseCidrList(rule.networks), ip);
  } catch {
    // A stored rule that no longer parses must fail closed: it was written
    // to restrict, and reading it as "no rule" would quietly lift that.
    return false;
  }
}

export function networkAllows(
  settings: PlatformSettings,
  user: Pick<UserRow, "allowedNetworks">,
  method: SignInMethod,
  ip: string
): boolean {
  return ruleAllows(effectiveRule(settings, user, method), ip);
}

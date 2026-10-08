import type { Request, Response } from "express";
import type { SignInMethod, User } from "../../contracts/platform.js";
import type { Core } from "../core.js";
import { clientIp } from "../net.js";
import { networkAllows, ruleAllows } from "./networks.js";
import { groupIsAdmin } from "./oidc.js";
import { sessionDueRecheck, sessionFromRequest, sessionHandle } from "./sessions.js";
import { bearerOf, tokenFromSecret } from "./tokens.js";
import { totpEnabledFor, totpRequiredFor } from "./totp.js";
import { userById } from "./users.js";

// Who is making a request is decided once per request, from the session
// cookie or the API token the platform itself issued. Nothing else a client
// sends can assert an identity.

// The contract's User plus what the platform's own routes need about the
// account behind it. Modules only ever see the contract's fields.
export interface PlatformUser extends User {
  // The account row behind a real sign-in; absent for the bypass and for
  // identities supplied by a test's identify().
  userId?: number;
  session?: string;
}

export interface AuthResult {
  user: PlatformUser | null;
  // Why a request with a valid session is still refused, for the 401 body.
  denied?: string;
  // The session is due an OIDC re-check: the client sends the browser back
  // through the provider instead of showing the sign-in page.
  reauth?: boolean;
}

export const DEV_USER_ID = "admin";

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

// Read per call rather than snapshotted at import, so tests can vary it and
// an operator's correction applies without a rebuild. The NODE_ENV gate is
// not overridable: the image sets production, so no combination of
// variables turns a deployed instance into one that asks nobody to sign in.
export function devBypassEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && truthy(process.env.DEV_AUTH);
}

// The environment's admin allowlists apply on top of the role an account
// has, so an install can name its admins in one place (a Helm value) and
// have them recognised at their first OIDC sign-in. Empty means nobody.
export function envAdmin(candidates: string[], groups: string[]): boolean {
  const users = envList("ADMIN_USERS");
  const adminGroups = envList("ADMIN_GROUPS");
  return (
    candidates.some((candidate) => candidate && users.includes(candidate.toLowerCase())) ||
    groups.some((group) => adminGroups.includes(group.toLowerCase()))
  );
}

function devUser(orgId: string): PlatformUser {
  return {
    id: DEV_USER_ID,
    name: "Development admin",
    email: "",
    groups: [],
    admin: true,
    source: "dev-bypass",
    mustChangePassword: false,
    orgId,
  };
}

// A refused session is retried by every poll the client makes, so the audit
// row is written at most once per session per window rather than per
// request. Bounded so a flood of distinct sessions cannot grow it forever;
// dropping the oldest entry only risks one extra row.
const NETWORK_DENIAL_WINDOW_MS = 10 * 60 * 1000;
const NETWORK_DENIAL_MAX = 1000;

export function createResolver(core: Core): (req: Request, res: Response | null) => AuthResult {
  const networkDenials = new Map<string, number>();

  const auditNetworkDenial = (idHash: string, username: string, ip: string, method: SignInMethod) => {
    const now = Date.now();
    const last = networkDenials.get(idHash);
    if (last !== undefined && now - last < NETWORK_DENIAL_WINDOW_MS) return;
    networkDenials.delete(idHash);
    if (networkDenials.size >= NETWORK_DENIAL_MAX) networkDenials.delete(networkDenials.keys().next().value!);
    networkDenials.set(idHash, now);
    core.audit.record({
      actor: username,
      ip,
      action: "auth.network-denied",
      target: "session",
      detail: `${method} session refused by network rule`,
      result: "denied",
    });
  };

  return (req, res) => {
    const ip = clientIp(req);
    // A request that brings a token is judged on it alone: a bad one is
    // refused rather than falling back to a cookie or the dev bypass.
    const bearer = bearerOf(req);
    if (bearer !== undefined) {
      const found = tokenFromSecret(core, bearer);
      if (found === null) return { user: null, denied: "That API token is not valid, has expired or was revoked." };
      const { token, account } = found;
      if (account.allowedNetworks.length > 0 && !ruleAllows({ networks: account.allowedNetworks, from: "user" }, ip)) {
        return { user: null, denied: `This account cannot be used from ${ip}.` };
      }
      return {
        user: {
          id: account.username,
          name: account.displayName || account.username,
          email: account.email,
          groups: [],
          admin: account.role === "admin" || envAdmin([account.username, account.email], []),
          source: "token",
          token: { id: token.id, scope: token.scope },
          userId: account.id,
          mustChangePassword: false,
          orgId: account.orgId,
        },
      };
    }
    const session = sessionFromRequest(core, req, res, ip);
    if (session !== null) {
      const account = userById(core.db, session.userId);
      if (account === null || account.disabled) return { user: null };
      // Checked on every request, not only at sign-in, so a session carried
      // to another network stops working there even though its cookie is
      // still valid.
      if (!networkAllows(core.settings, account, session.method, ip)) {
        auditNetworkDenial(session.idHash, account.username, ip, session.method);
        return { user: null, denied: `This account cannot be used from ${ip}.` };
      }
      const groups = session.method === "oidc" ? session.groups : [];
      const admin =
        account.role === "admin" ||
        (session.method === "oidc" && groupIsAdmin(core, groups)) ||
        envAdmin([account.username, account.email], groups);
      return {
        user: {
          id: account.username,
          name: account.displayName || account.username,
          email: account.email,
          groups,
          admin,
          source: session.method,
          userId: account.id,
          session: sessionHandle(session.idHash),
          mustChangePassword: account.mustChangePassword,
          mustEnrollTotp:
            session.method === "password" &&
            core.settings.bool("auth.totp.enabled") &&
            totpRequiredFor(admin, core.settings.string("auth.totp.require")) &&
            !totpEnabledFor(core, account.id),
          orgId: account.orgId,
        },
      };
    }
    // Never the bypass: a real session exists and has to be re-checked.
    if (sessionDueRecheck(core, req) !== null) {
      return { user: null, denied: "Your sign-in has to be checked with your provider again.", reauth: true };
    }
    return { user: devBypassEnabled() ? devUser(core.orgId) : null };
  };
}

// The body of every 401, so each one carries the reason and whether a
// re-check would fix it.
export function unauthorizedBody(auth: AuthResult | undefined): { error: string; reauth?: true } {
  const error = auth?.denied ?? "Not signed in.";
  return auth?.reauth ? { error, reauth: true } : { error };
}

// 401 for no identity; 403 for an account that has to choose a new password
// or add an authenticator before it may do anything else, which the client
// turns into that form rather than a sign-in page.
export function refuseUnready(auth: AuthResult | undefined, res: Response): PlatformUser | null {
  const user = auth?.user ?? null;
  if (user === null) {
    res.status(401).json(unauthorizedBody(auth));
    return null;
  }
  if (user.mustChangePassword) {
    res.status(403).json({ error: "Choose a new password to continue.", mustChangePassword: true });
    return null;
  }
  if (user.mustEnrollTotp) {
    res.status(403).json({ error: "Set up two-factor sign-in to continue.", mustEnrollTotp: true });
    return null;
  }
  return user;
}

// Called once at startup. The bypass has to be impossible to mistake for a
// working login, because the symptom of leaving it on is that everything
// works perfectly for everyone.
const bannerLine = (text: string) => `*** ${text.padEnd(59)} ***`;

export function announceAuthMode(): void {
  if (!devBypassEnabled()) return;
  console.warn("*".repeat(67));
  console.warn(bannerLine("AUTH BYPASS ACTIVE: every request without a session is admin"));
  console.warn(bannerLine('DEV_AUTH is set and NODE_ENV is not "production".'));
  console.warn(bannerLine("Development only. Never expose this process to a network."));
  console.warn("*".repeat(67));
}

// Each request's result, set once by the platform's middleware and read by
// everything after it, so a request never resolves (or slides) twice.
const results = new WeakMap<Request, AuthResult>();

export function setAuth(req: Request, result: AuthResult): void {
  results.set(req, result);
}

export function authOf(req: Request): AuthResult | undefined {
  return results.get(req);
}

export function currentUser(req: Request): PlatformUser | null {
  return results.get(req)?.user ?? null;
}

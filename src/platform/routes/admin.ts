import express, { type Request, type Response, type Router } from "express";
import type {
  AdminOverview,
  OAuthAuthorizeParams,
  OAuthConsentRequest,
  OAuthConsentView,
  AuthentikWirePlan,
  AuthentikWireResult,
  PocketIdWirePlan,
  PocketIdWireResult,
  PublicSignInProvider,
  PublicSignInResult,
  Role,
  SessionView,
  SettingValue,
  UserView,
} from "../../contracts/auth.js";
import { product } from "../../product.js";
import { AuthentikError, authentikUrlProblem, issuerFor, wireAuthentik } from "../auth/authentik.js";
import { PocketIdError, pocketIdIssuer, pocketIdUrlProblem, wirePocketId } from "../auth/pocketid.js";
import { authOf, envAdmin, refuseUnready, type PlatformUser } from "../auth/identity.js";
import { effectiveRule, ruleAllows } from "../auth/networks.js";
import {
  CALLBACK_PATH,
  GOOGLE_ISSUER,
  MICROSOFT_COMMON_ISSUER,
  OIDC_SECRET,
  OidcError,
  discover,
  oidcUnavailableReason,
} from "../auth/oidc.js";
import { generateTempPassword, hashPassword, passwordProblem } from "../auth/passwords.js";
import { revokeAllSessions, revokeSession, sessionHandle, sessionsOf } from "../auth/sessions.js";
import { OAuthError, checkAuthorizeRequest, issueCode, redirectWith, scopeOf } from "../auth/oauth.js";
import { createToken, limitsOf, listTokens, revokeToken, tokenView, updateToken } from "../auth/tokens.js";
import { clearTotp, totpEnabledFor } from "../auth/totp.js";
import {
  countActiveAdmins,
  createUser,
  deleteUser,
  identitiesOf,
  listUsers,
  normalizeUsername,
  unlinkIdentities,
  updateUser,
  userById,
  userByUsername,
  usernameProblem,
  type UserRow,
} from "../auth/users.js";
import { effectivePublicUrl, iso, isoOrNull, publicOrigin, type Core } from "../core.js";
import { clientIp, parseCidrList } from "../net.js";
import { secretKeyConfigured } from "../secretBox.js";
import { SettingError } from "../settings.js";
import { SignInError, createSignIn } from "../signin.js";
import { mcpResource, oauthBase } from "./oauth.js";

// Everything an admin manages about the platform itself: its settings, who
// may sign in and from where, and the record of what happened. Every change
// is audited, and every change that could lock the acting admin (or every
// admin) out is refused before it is made. Mounted at /api/admin.

class AdminError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function tokenLimits(body: Record<string, unknown>): ReturnType<typeof limitsOf> {
  try {
    return limitsOf(body);
  } catch (err) {
    throw new AdminError(400, (err as Error).message);
  }
}

// For the audit row: the scope and, when limited, what to.
function grantSummary(row: { scope: string; namespaces?: string[]; areas?: string[] }): string {
  const parts = [row.scope];
  if (row.areas) parts.push(`areas ${row.areas.join(", ")}`);
  if (row.namespaces) parts.push(`namespaces ${row.namespaces.join(", ")}`);
  return parts.join("; ");
}

function roleOf(raw: unknown): Role {
  if (raw === "admin" || raw === "user") return raw;
  throw new AdminError(400, "Role must be admin or user.");
}

function networksOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new AdminError(400, "Allowed networks must be a list.");
  const entries = [...new Set(raw.map((entry) => String(entry).trim()).filter(Boolean))];
  try {
    parseCidrList(entries);
  } catch (err) {
    throw new AdminError(400, (err as Error).message);
  }
  return entries;
}

// Whether a token's account is an admin without a sign-in: its role or the
// environment's allowlist (OIDC group membership needs a session).
const isAdmin = (account: UserRow) => account.role === "admin" || envAdmin([account.username, account.email], []);

const AUTHENTIK_TOKEN = { scope: "auth", id: "authentik-api" } as const;
const WIRED_KEYS = ["auth.oidc.issuer", "auth.oidc.clientId", "auth.oidc.label", "auth.oidc.enabled"];

const baseUrl =
  (problemOf: (raw: string, use: "public" | "api") => string | null) =>
  (raw: unknown, use: "public" | "api" = "public"): string => {
    const value = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
    const problem = problemOf(value, use);
    if (problem !== null) throw new AdminError(400, problem);
    return value;
  };
const authentikBase = baseUrl(authentikUrlProblem);

const POCKET_ID_KEY = { scope: "auth", id: "pocket-id-api" } as const;
const pocketIdBase = baseUrl(pocketIdUrlProblem);
// Pocket ID puts the groups claim in tokens only for this scope.
const GROUPS_SCOPE = "groups";
const pocketIdKeys = (adminGroups: boolean) =>
  adminGroups ? [...WIRED_KEYS, "auth.oidc.adminGroups", "auth.oidc.scopes"] : WIRED_KEYS;

type Handler = (req: Request, res: Response, admin: PlatformUser) => Promise<unknown> | unknown;

export function adminRouter(core: Core, signIn = createSignIn(core)): Router {
  const router = express.Router();
  const s = core.settings;

  // One admin check and one error shape for every route; a returned value
  // is the JSON body.
  const route =
    (handler: Handler) =>
    async (req: Request, res: Response): Promise<void> => {
      const admin = refuseUnready(authOf(req), res);
      if (admin === null) return;
      if (!admin.admin) {
        res.status(403).json({ error: "Admins only." });
        return;
      }
      try {
        const body = await handler(req, res, admin);
        if (body !== undefined && !res.headersSent) res.json(body);
      } catch (err) {
        if (err instanceof AdminError || err instanceof SettingError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        core.log.error("Admin request failed", { method: req.method, path: req.path, error: (err as Error).message });
        res.status(500).json({ error: "Internal error." });
      }
    };

  const record = (req: Request, admin: PlatformUser, action: string, target: string, detail = "") => {
    core.audit.record({ actor: admin.id, ip: clientIp(req), action: `admin.${action}`, target, detail, result: "ok" });
  };

  const userView = (row: UserRow): UserView => ({
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    email: row.email,
    role: row.role,
    disabled: row.disabled,
    mustChangePassword: row.mustChangePassword,
    hasPassword: row.passwordHash !== null,
    totpEnabled: totpEnabledFor(core, row.id),
    allowedNetworks: row.allowedNetworks,
    createdAt: iso(row.createdAt),
    lastLoginAt: isoOrNull(row.lastLoginAt),
    identities: identitiesOf(core.db, row.id).map(({ provider, subject, email, createdAt, lastUsedAt }) => ({
      provider,
      subject,
      email,
      createdAt: iso(createdAt),
      lastUsedAt: isoOrNull(lastUsedAt),
    })),
  });

  const targetUser = (req: Request): UserRow => {
    const id = Number(req.params.id);
    const row = Number.isInteger(id) ? userById(core.db, id) : null;
    if (row === null) throw new AdminError(404, "No such user.");
    return row;
  };

  // --- Lockout guards -----------------------------------------------------

  // Would this admin still get in from where they are now, after a change to
  // their own network list?
  const assertStillReachable = (req: Request, admin: PlatformUser, account: Pick<UserRow, "allowedNetworks">) => {
    if (admin.source === "dev-bypass" || admin.source === "token") return;
    const ip = clientIp(req);
    if (!ruleAllows(effectiveRule(s, account, admin.source), ip)) {
      throw new AdminError(
        409,
        `That would lock you out: you are signed in from ${ip}, which the new rule does not include. Add it, or make the change from an allowed network.`
      );
    }
  };

  const guardSettingChange = (req: Request, admin: PlatformUser, key: string, next: unknown) => {
    if (key === "auth.password.enabled" && next === false) {
      if (s.get("auth.oidc.enabled") !== true) {
        throw new AdminError(409, "Turn on OIDC sign-in before turning off passwords, or nobody could sign in.");
      }
      if (admin.source !== "oidc") {
        throw new AdminError(
          409,
          "Sign in with OIDC once before turning off passwords, so it is proven to work for you."
        );
      }
    }
    if (key === "auth.oidc.enabled" && next === false && s.get("auth.password.enabled") !== true) {
      throw new AdminError(409, "Password sign-in is off; turning off OIDC too would leave no way in.");
    }
    const methodKey =
      admin.source === "password" ? "auth.password.networks" : admin.source === "oidc" ? "auth.oidc.networks" : null;
    if (key === methodKey && admin.userId !== undefined) {
      const account = userById(core.db, admin.userId);
      // The method's list only binds an admin with no list of their own.
      if (account !== null && account.allowedNetworks.length === 0 && Array.isArray(next) && next.length > 0) {
        const ip = clientIp(req);
        if (!ruleAllows({ networks: next as string[], from: "method" }, ip)) {
          throw new AdminError(
            409,
            `That would lock you out: you are signed in from ${ip}, which the new list does not include.`
          );
        }
      }
    }
  };

  const assertNotLastAdmin = (row: UserRow, change: { role?: Role; disabled?: boolean; deleting?: boolean }) => {
    const losesAdmin =
      change.deleting || change.disabled === true || (change.role !== undefined && change.role !== "admin");
    if (row.role === "admin" && !row.disabled && losesAdmin && countActiveAdmins(core.db) <= 1) {
      throw new AdminError(409, "This is the last active admin account. Make someone else an admin first.");
    }
  };

  // --- Settings -----------------------------------------------------------

  router.get(
    "/overview",
    route(async (req): Promise<AdminOverview> => {
      const publicUrl = effectivePublicUrl(core, req);
      return {
        settings: s.describe(),
        environment: s.describeEnvironment(),
        publicUrl,
        oidc: {
          redirectUri: publicUrl.value ? `${publicUrl.value}${CALLBACK_PATH}` : "",
          hasSecret: await core.secrets.has(OIDC_SECRET.scope, OIDC_SECRET.id),
          unavailable: await oidcUnavailableReason(core),
        },
        secretKeyConfigured: secretKeyConfigured(),
        you: { ip: clientIp(req) },
        version: process.env.GIT_SHA || "dev",
      };
    })
  );

  router.put(
    "/settings/:key",
    route((req, _res, admin) => {
      const key = String(req.params.key);
      const def = s.definition(key);
      const value = def.coerce((req.body ?? {}).value);
      guardSettingChange(req, admin, key, value);
      s.set(key, value, admin.id);
      record(req, admin, "setting-change", key, JSON.stringify(value));
      return { key, value: value as SettingValue };
    })
  );

  router.delete(
    "/settings/:key",
    route((req, _res, admin) => {
      const key = String(req.params.key);
      guardSettingChange(req, admin, key, s.fallback(key));
      s.reset(key);
      record(req, admin, "setting-reset", key);
      return { key, value: s.get(key) as SettingValue };
    })
  );

  router.put(
    "/oidc/secret",
    route(async (req, _res, admin) => {
      const raw = (req.body ?? {}).value;
      if (typeof raw !== "string") throw new AdminError(400, "Send the client secret as a string; empty clears it.");
      const value = raw.trim();
      if ([...value].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) {
        throw new AdminError(400, "That secret contains control characters.");
      }
      if (value === "") {
        await core.secrets.delete(OIDC_SECRET.scope, OIDC_SECRET.id);
      } else {
        if (!secretKeyConfigured())
          throw new AdminError(409, "SECRETS_KEY is not set, so the secret cannot be stored.");
        await core.secrets.putAs(OIDC_SECRET.scope, OIDC_SECRET.id, value, admin.id);
      }
      record(req, admin, value ? "oidc-secret-set" : "oidc-secret-clear", "auth/oidc");
      return { hasSecret: value !== "" };
    })
  );

  router.post(
    "/oidc/test",
    route(async () => {
      const issuer = s.string("auth.oidc.issuer");
      if (!issuer) throw new AdminError(400, "Enter an issuer URL first.");
      try {
        const meta = await discover(issuer.replace(/\/+$/, ""));
        return { ok: true, issuer: meta.issuer };
      } catch (err) {
        return { ok: false, error: err instanceof OidcError ? err.message : "Discovery failed." };
      }
    })
  );

  // --- Authentik ----------------------------------------------------------

  const wireBlocked = (adminGroups: boolean): string | null =>
    signIn.blocked(adminGroups ? [...WIRED_KEYS, "auth.oidc.adminGroups"] : WIRED_KEYS)?.message ?? null;

  router.get(
    "/oidc/authentik",
    route(async (req): Promise<AuthentikWirePlan> => {
      const base = authentikBase(req.query.url);
      const apiUrl = authentikBase(req.query.apiUrl || base, "api");
      const origin = publicOrigin(core);
      return {
        authentikUrl: base,
        ...(apiUrl !== base ? { apiUrl } : {}),
        applicationName: product.displayName,
        slug: product.slug,
        redirectUri: origin ? `${origin}${CALLBACK_PATH}` : "",
        issuer: issuerFor(base, product.slug),
        hasStoredToken: await core.secrets.has(AUTHENTIK_TOKEN.scope, AUTHENTIK_TOKEN.id),
        blocked: wireBlocked(false),
      };
    })
  );

  router.post(
    "/oidc/authentik",
    route(async (req, _res, admin): Promise<AuthentikWireResult> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const base = authentikBase(body.authentikUrl);
      const apiUrl = authentikBase(body.apiUrl || base, "api");
      let adminGroups: string[] | undefined;
      if (body.adminGroups !== undefined) {
        if (!Array.isArray(body.adminGroups)) throw new AdminError(400, "Admin groups must be a list.");
        adminGroups = body.adminGroups.map((g) => String(g).trim()).filter(Boolean);
      }
      const blocked = signIn.blocked(adminGroups !== undefined ? [...WIRED_KEYS, "auth.oidc.adminGroups"] : WIRED_KEYS);
      if (blocked !== null) throw new AdminError(blocked.status, blocked.message);

      const pasted = typeof body.token === "string" ? body.token.trim() : "";
      const token = pasted || ((await core.secrets.get(AUTHENTIK_TOKEN.scope, AUTHENTIK_TOKEN.id)) ?? "");
      if (!token) throw new AdminError(400, "Paste an Authentik API token.");

      const origin = publicOrigin(core);
      const redirectUri = `${origin}${CALLBACK_PATH}`;
      let outcome;
      try {
        outcome = await wireAuthentik({
          apiUrl,
          publicUrl: base,
          token,
          slug: product.slug,
          name: product.displayName,
          redirectUri,
          launchUrl: origin,
        });
      } catch (err) {
        if (err instanceof AuthentikError) throw new AdminError(502, err.message);
        throw err;
      }

      try {
        await signIn.setOidcClient(
          {
            issuer: outcome.issuer,
            clientId: outcome.clientId,
            clientSecret: outcome.clientSecret,
            label: "Sign in with Authentik",
            enabled: true,
            ...(adminGroups !== undefined ? { adminGroups } : {}),
          },
          admin.id
        );
      } catch (err) {
        if (err instanceof SignInError) throw new AdminError(err.status, err.message);
        throw err;
      }
      const settings = adminGroups !== undefined ? [...WIRED_KEYS, "auth.oidc.adminGroups"] : WIRED_KEYS;

      const tokenKept = body.keepToken === true;
      if (tokenKept) await core.secrets.putAs(AUTHENTIK_TOKEN.scope, AUTHENTIK_TOKEN.id, token, admin.id);
      else await core.secrets.delete(AUTHENTIK_TOKEN.scope, AUTHENTIK_TOKEN.id);

      let discovery: AuthentikWireResult["discovery"];
      try {
        await discover(outcome.issuer.replace(/\/+$/, ""));
        discovery = { ok: true };
      } catch (err) {
        discovery = { ok: false, error: err instanceof OidcError ? err.message : "Discovery failed." };
      }

      record(
        req,
        admin,
        "oidc-authentik-wire",
        base,
        `slug=${product.slug} application=${outcome.application} provider=${outcome.provider} token=${tokenKept ? "kept" : "discarded"}`
      );
      return {
        authentikUrl: base,
        slug: product.slug,
        issuer: outcome.issuer,
        clientId: outcome.clientId,
        redirectUri,
        application: outcome.application,
        provider: outcome.provider,
        settings,
        tokenKept,
        discovery,
        testSignIn: "auth/oidc/start?link=1",
      };
    })
  );

  // --- Pocket ID ----------------------------------------------------------

  router.get(
    "/oidc/pocket-id",
    route(async (req): Promise<PocketIdWirePlan> => {
      const base = pocketIdBase(req.query.url);
      const apiUrl = pocketIdBase(req.query.apiUrl || base, "api");
      const origin = publicOrigin(core);
      return {
        pocketIdUrl: base,
        ...(apiUrl !== base ? { apiUrl } : {}),
        clientName: product.displayName,
        clientId: product.slug,
        redirectUri: origin ? `${origin}${CALLBACK_PATH}` : "",
        issuer: pocketIdIssuer(base),
        hasStoredKey: await core.secrets.has(POCKET_ID_KEY.scope, POCKET_ID_KEY.id),
        blocked: signIn.blocked(WIRED_KEYS)?.message ?? null,
      };
    })
  );

  router.post(
    "/oidc/pocket-id",
    route(async (req, _res, admin): Promise<PocketIdWireResult> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const base = pocketIdBase(body.pocketIdUrl);
      const apiUrl = pocketIdBase(body.apiUrl || base, "api");
      let adminGroups: string[] | undefined;
      if (body.adminGroups !== undefined) {
        if (!Array.isArray(body.adminGroups)) throw new AdminError(400, "Admin groups must be a list.");
        adminGroups = body.adminGroups.map((g) => String(g).trim()).filter(Boolean);
      }
      const settings = pocketIdKeys(adminGroups !== undefined);
      const blocked = signIn.blocked(settings);
      if (blocked !== null) throw new AdminError(blocked.status, blocked.message);

      const pasted = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      const apiKey = pasted || ((await core.secrets.get(POCKET_ID_KEY.scope, POCKET_ID_KEY.id)) ?? "");
      if (!apiKey) throw new AdminError(400, "Paste a Pocket ID API key.");

      const origin = publicOrigin(core);
      const redirectUri = `${origin}${CALLBACK_PATH}`;
      let outcome;
      try {
        outcome = await wirePocketId({
          apiUrl,
          publicUrl: base,
          apiKey,
          clientId: product.slug,
          name: product.displayName,
          redirectUri,
          launchUrl: origin,
        });
      } catch (err) {
        if (err instanceof PocketIdError) throw new AdminError(502, err.message);
        throw err;
      }

      const scopes = new Set(s.string("auth.oidc.scopes").split(/\s+/).filter(Boolean));
      scopes.add(GROUPS_SCOPE);
      try {
        await signIn.setOidcClient(
          {
            issuer: outcome.issuer,
            clientId: outcome.clientId,
            clientSecret: outcome.clientSecret,
            label: "Sign in with Pocket ID",
            enabled: true,
            ...(adminGroups !== undefined ? { adminGroups, scopes: [...scopes].join(" ") } : {}),
          },
          admin.id
        );
      } catch (err) {
        if (err instanceof SignInError) throw new AdminError(err.status, err.message);
        throw err;
      }

      const keyKept = body.keepKey === true;
      if (keyKept) await core.secrets.putAs(POCKET_ID_KEY.scope, POCKET_ID_KEY.id, apiKey, admin.id);
      else await core.secrets.delete(POCKET_ID_KEY.scope, POCKET_ID_KEY.id);

      let discovery: PocketIdWireResult["discovery"];
      try {
        await discover(outcome.issuer);
        discovery = { ok: true };
      } catch (err) {
        discovery = { ok: false, error: err instanceof OidcError ? err.message : "Discovery failed." };
      }

      record(
        req,
        admin,
        "oidc-pocket-id-wire",
        base,
        `clientId=${outcome.clientId} client=${outcome.client} key=${keyKept ? "kept" : "discarded"}`
      );
      return {
        pocketIdUrl: base,
        issuer: outcome.issuer,
        clientId: outcome.clientId,
        redirectUri,
        client: outcome.client,
        settings,
        keyKept,
        discovery,
        testSignIn: "auth/oidc/start?link=1",
      };
    })
  );

  // --- Google and Microsoft accounts -------------------------------------

  const PUBLIC_PROVIDERS: Record<PublicSignInProvider, { issuer: string; label: string }> = {
    google: { issuer: GOOGLE_ISSUER, label: "Sign in with Google" },
    microsoft: { issuer: MICROSOFT_COMMON_ISSUER, label: "Sign in with Microsoft" },
  };
  // Saved beside the OIDC client: what makes a public provider safe to open.
  const PUBLIC_KEYS = [
    "auth.oidc.scopes",
    "auth.oidc.usernameClaim",
    "auth.oidc.autoProvision",
    "auth.oidc.allowedGroups",
    "auth.oidc.allowedEmails",
    "auth.oidc.adminEmails",
  ];
  const EMAIL_ENTRY = /^(?:[^\s@]+@)?@?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

  const emailEntries = (raw: unknown, what: string): string[] => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) throw new AdminError(400, `${what} must be a list.`);
    const entries = raw.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
    const bad = entries.find((entry) => !EMAIL_ENTRY.test(entry) || entry.includes("@@"));
    if (bad !== undefined)
      throw new AdminError(
        400,
        `${what}: "${bad}" is neither an address (ann@example.com) nor a domain (@example.com).`
      );
    return [...new Set(entries)];
  };

  router.post(
    "/oidc/public",
    route(async (req, _res, admin): Promise<PublicSignInResult> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const provider = body.provider;
      if (provider !== "google" && provider !== "microsoft")
        throw new AdminError(400, 'Provider must be "google" or "microsoft".');
      const preset = PUBLIC_PROVIDERS[provider];
      const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
      if (!clientId) throw new AdminError(400, "Enter the client ID.");
      const allowedEmails = emailEntries(body.allowedEmails, "Allowed email addresses");
      if (allowedEmails.length === 0)
        throw new AdminError(
          400,
          "List at least one allowed address or domain: anyone with a Google or Microsoft account could sign in otherwise."
        );
      const adminEmails = emailEntries(body.adminEmails, "Admin email addresses");

      const blocked = signIn.blocked([...WIRED_KEYS, "auth.oidc.adminGroups", ...PUBLIC_KEYS]);
      if (blocked !== null) throw new AdminError(blocked.status, blocked.message);

      let clientSecret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
      if (!clientSecret) {
        const same = s.string("auth.oidc.issuer") === preset.issuer && s.string("auth.oidc.clientId") === clientId;
        clientSecret = same ? ((await core.secrets.get(OIDC_SECRET.scope, OIDC_SECRET.id)) ?? "") : "";
        if (!clientSecret) throw new AdminError(400, "Paste the client secret.");
      }

      // The allow list goes in before sign-in is pointed at the provider, so
      // there is no moment where it is open to everyone.
      s.set("auth.oidc.allowedEmails", allowedEmails, admin.id);
      s.set("auth.oidc.adminEmails", adminEmails, admin.id);
      s.set("auth.oidc.allowedGroups", [], admin.id);
      s.set("auth.oidc.scopes", "openid profile email", admin.id);
      s.set("auth.oidc.usernameClaim", "email", admin.id);
      s.set("auth.oidc.autoProvision", true, admin.id);
      try {
        await signIn.setOidcClient(
          {
            issuer: preset.issuer,
            clientId,
            clientSecret,
            label: preset.label,
            adminGroups: [],
            enabled: true,
          },
          admin.id
        );
      } catch (err) {
        if (err instanceof SignInError) throw new AdminError(err.status, err.message);
        throw err;
      }

      let discovery: PublicSignInResult["discovery"];
      try {
        await discover(preset.issuer);
        discovery = { ok: true };
      } catch (err) {
        discovery = { ok: false, error: err instanceof OidcError ? err.message : "Discovery failed." };
      }
      record(
        req,
        admin,
        "oidc-public-wire",
        preset.issuer,
        `provider=${provider} allowed=${allowedEmails.length} admins=${adminEmails.length}`
      );
      return {
        provider,
        issuer: preset.issuer,
        clientId,
        redirectUri: `${publicOrigin(core)}${CALLBACK_PATH}`,
        settings: [...WIRED_KEYS, "auth.oidc.adminGroups", ...PUBLIC_KEYS],
        discovery,
      };
    })
  );

  // --- Users --------------------------------------------------------------

  router.get(
    "/users",
    route(() => listUsers(core.db).map(userView))
  );

  router.post(
    "/users",
    route(async (req, res, admin) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const username = normalizeUsername(typeof body.username === "string" ? body.username : "");
      const problem = usernameProblem(username);
      if (problem !== null) throw new AdminError(400, problem);
      if (userByUsername(core.db, username) !== null) throw new AdminError(409, `"${username}" already exists.`);
      // null makes an account that can only be claimed by an OIDC sign-in
      // with this username or email; omitted gives a one-time password. A
      // password the admin chose still has to be changed, since the admin
      // knows it.
      let password: string | null;
      let generated: string | null = null;
      if (body.password === null) {
        password = null;
      } else if (typeof body.password === "string") {
        const weak = passwordProblem(body.password);
        if (weak !== null) throw new AdminError(400, weak);
        password = body.password;
      } else if (body.password === undefined) {
        password = generated = generateTempPassword();
      } else {
        throw new AdminError(400, "Password must be a string, null, or left out.");
      }
      const row = createUser(core.db, {
        orgId: core.orgId,
        username,
        displayName: typeof body.displayName === "string" ? body.displayName.trim() : "",
        email: typeof body.email === "string" ? body.email.trim().toLowerCase() : "",
        role: roleOf(body.role ?? "user"),
        passwordHash: password === null ? null : await hashPassword(password),
        mustChangePassword: password !== null,
      });
      const kind = password === null ? "none" : generated === null ? "set" : "temporary";
      record(req, admin, "user-create", username, `role=${row.role} password=${kind}`);
      res.status(201);
      return { user: userView(row), temporaryPassword: generated };
    })
  );

  router.patch(
    "/users/:id",
    route((req, _res, admin) => {
      const row = targetUser(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const changes: Parameters<typeof updateUser>[2] = {};
      if (body.displayName !== undefined) changes.displayName = String(body.displayName).trim();
      if (body.email !== undefined) changes.email = String(body.email).trim().toLowerCase();
      if (body.role !== undefined) changes.role = roleOf(body.role);
      if (body.disabled !== undefined) changes.disabled = body.disabled === true;
      if (body.allowedNetworks !== undefined) changes.allowedNetworks = networksOf(body.allowedNetworks);

      const self = admin.userId === row.id;
      if (self && changes.disabled === true) throw new AdminError(409, "You cannot disable your own account.");
      if (self && changes.role === "user") {
        throw new AdminError(409, "You cannot remove your own admin role; ask another admin.");
      }
      assertNotLastAdmin(row, changes);
      if (self && changes.allowedNetworks !== undefined) {
        assertStillReachable(req, admin, { allowedNetworks: changes.allowedNetworks });
      }

      const updated = updateUser(core.db, row.id, changes)!;
      // A disabled account's sessions are already refused on every request;
      // ending them as well keeps the session list honest.
      if (changes.disabled === true) revokeAllSessions(core, row.id);
      record(req, admin, "user-update", row.username, JSON.stringify(changes));
      return userView(updated);
    })
  );

  router.post(
    "/users/:id/password",
    route(async (req, _res, admin) => {
      const row = targetUser(req);
      const password = generateTempPassword();
      updateUser(core.db, row.id, { passwordHash: await hashPassword(password), mustChangePassword: true });
      revokeAllSessions(core, row.id);
      record(req, admin, "user-password-reset", row.username);
      return { temporaryPassword: password };
    })
  );

  router.post(
    "/users/:id/totp/reset",
    route((req, _res, admin) => {
      const row = targetUser(req);
      clearTotp(core, row.id);
      revokeAllSessions(core, row.id);
      record(req, admin, "user-totp-reset", row.username);
      return { ok: true };
    })
  );

  router.delete(
    "/users/:id",
    route((req, _res, admin) => {
      const row = targetUser(req);
      if (admin.userId === row.id) throw new AdminError(409, "You cannot delete your own account.");
      assertNotLastAdmin(row, { deleting: true });
      deleteUser(core.db, row.id);
      record(req, admin, "user-delete", row.username);
      return { ok: true };
    })
  );

  router.get(
    "/users/:id/sessions",
    route((req): SessionView[] =>
      sessionsOf(core, targetUser(req).id).map((session) => ({
        id: sessionHandle(session.idHash),
        method: session.method,
        ip: session.ip,
        userAgent: session.userAgent,
        createdAt: iso(session.createdAt),
        lastSeenAt: iso(session.lastSeenAt),
      }))
    )
  );

  router.delete(
    "/users/:id/sessions",
    route((req, _res, admin) => {
      const row = targetUser(req);
      const ended = revokeAllSessions(core, row.id);
      record(req, admin, "sessions-revoke-all", row.username, `${ended} ended`);
      return { ended };
    })
  );

  router.delete(
    "/users/:id/sessions/:handle",
    route((req, _res, admin) => {
      const row = targetUser(req);
      if (!revokeSession(core, row.id, String(req.params.handle))) throw new AdminError(404, "No such session.");
      record(req, admin, "session-revoke", row.username);
      return { ok: true };
    })
  );

  router.delete(
    "/users/:id/identities",
    route((req, _res, admin) => {
      const row = targetUser(req);
      const provider = typeof req.body?.provider === "string" ? (req.body.provider as string) : "";
      if (!provider || unlinkIdentities(core.db, row.id, provider) === 0) {
        throw new AdminError(404, "No such linked sign-in.");
      }
      record(req, admin, "identity-unlink", row.username, provider);
      return userView(userById(core.db, row.id)!);
    })
  );

  // --- API tokens ---------------------------------------------------------

  router.get(
    "/tokens",
    route(() => listTokens(core).map((row) => tokenView(core, row, isAdmin)))
  );

  router.post(
    "/tokens",
    route((req, _res, admin) => {
      if (admin.userId === undefined) {
        throw new AdminError(409, "Sign in with an account to create a token: it acts as that account.");
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 80) throw new AdminError(400, "Give the token a name of up to 80 characters.");
      if (body.scope !== "read" && body.scope !== "write") throw new AdminError(400, "Scope must be read or write.");
      const days = body.expiresInDays ?? null;
      if (days !== null && (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650)) {
        throw new AdminError(400, "Expiry must be a whole number of days from 1 to 3650, or none.");
      }
      const limits = tokenLimits(body);
      const { row, secret } = createToken(core, {
        name,
        scope: body.scope,
        ...(limits.namespaces ? { namespaces: limits.namespaces } : {}),
        ...(limits.areas ? { areas: limits.areas } : {}),
        userId: admin.userId,
        expiresInDays: days,
      });
      record(req, admin, "token-create", row.id, `${name} (${grantSummary(row)})`);
      return { token: tokenView(core, row, isAdmin), secret };
    })
  );

  router.patch(
    "/tokens/:id",
    route((req, _res, admin) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      let name: string | undefined;
      if (body.name !== undefined) {
        name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name || name.length > 80) throw new AdminError(400, "Give the token a name of up to 80 characters.");
      }
      if (body.scope !== undefined && body.scope !== "read" && body.scope !== "write") {
        throw new AdminError(400, "Scope must be read or write.");
      }
      const limits = tokenLimits(body);
      const row = updateToken(core, req.params.id ?? "", {
        ...(name !== undefined ? { name } : {}),
        ...(body.scope !== undefined ? { scope: body.scope as "read" | "write" } : {}),
        ...(limits.namespaces !== undefined ? { namespaces: limits.namespaces } : {}),
        ...(limits.areas !== undefined ? { areas: limits.areas } : {}),
      });
      if (row === null) throw new AdminError(404, "No such token.");
      record(req, admin, "token-update", row.id, `${row.name} (${grantSummary(row)})`);
      return tokenView(core, row, isAdmin);
    })
  );

  router.delete(
    "/tokens/:id",
    route((req, _res, admin) => {
      const row = revokeToken(core, req.params.id ?? "");
      if (row === null) throw new AdminError(404, "No such token.");
      record(req, admin, "token-revoke", row.id, row.name);
      return { ok: true };
    })
  );

  // --- OAuth consent for MCP clients --------------------------------------

  router.post(
    "/oauth/consent",
    route((req, _res, admin) => {
      const body = (req.body ?? {}) as Partial<OAuthConsentRequest>;
      const params = (body.params ?? {}) as Partial<OAuthAuthorizeParams>;
      let checked: ReturnType<typeof checkAuthorizeRequest>;
      try {
        checked = checkAuthorizeRequest(core, params, mcpResource(oauthBase(core, req)));
      } catch (err) {
        if (err instanceof OAuthError) throw new AdminError(400, err.message);
        throw err;
      }
      const { client, redirectUri } = checked;
      const requestedScope = scopeOf(params.scope);
      const view: OAuthConsentView = {
        client: { id: client.clientId, name: client.name, redirectUri },
        requestedScope,
      };
      if (body.decision === "deny") {
        record(req, admin, "oauth-deny", client.clientId, client.name);
        return { ...view, redirect: redirectWith(redirectUri, { error: "access_denied", state: params.state }) };
      }
      if (body.decision !== "approve") return view;
      if (admin.userId === undefined) {
        throw new AdminError(409, "Sign in with an account to approve: the grant acts as that account.");
      }
      const scope = body.scope ?? requestedScope;
      if (scope !== "read" && scope !== "write") throw new AdminError(400, "Scope must be read or write.");
      const limits = tokenLimits(body as Record<string, unknown>);
      const grant = {
        scope,
        ...(limits.namespaces ? { namespaces: limits.namespaces } : {}),
        ...(limits.areas ? { areas: limits.areas } : {}),
      };
      const code = issueCode(core, {
        clientId: client.clientId,
        userId: admin.userId,
        ...grant,
        redirectUri,
        codeChallenge: params.code_challenge!,
      });
      record(req, admin, "oauth-approve", client.clientId, `${client.name} (${grantSummary(grant)})`);
      return { ...view, redirect: redirectWith(redirectUri, { code, state: params.state }) };
    })
  );

  // --- Audit --------------------------------------------------------------

  router.get(
    "/audit",
    route((req) => {
      const limit = Number(req.query.limit ?? 200);
      const before = req.query.before !== undefined ? Number(req.query.before) : undefined;
      return core.audit.read(
        Number.isFinite(limit) ? limit : 200,
        before !== undefined && Number.isFinite(before) ? before : undefined
      );
    })
  );

  return router;
}

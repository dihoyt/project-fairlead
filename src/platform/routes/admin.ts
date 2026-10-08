import express, { type Request, type Response, type Router } from "express";
import type { AdminOverview, Role, SessionView, SettingValue, UserView } from "../../contracts/auth.js";
import { authOf, envAdmin, refuseUnready, type PlatformUser } from "../auth/identity.js";
import { effectiveRule, ruleAllows } from "../auth/networks.js";
import { CALLBACK_PATH, OIDC_SECRET, OidcError, discover, oidcUnavailableReason } from "../auth/oidc.js";
import { generateTempPassword, hashPassword, passwordProblem } from "../auth/passwords.js";
import { revokeAllSessions, revokeSession, sessionHandle, sessionsOf } from "../auth/sessions.js";
import { createToken, listTokens, revokeToken, tokenView } from "../auth/tokens.js";
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
import { effectivePublicUrl, iso, isoOrNull, type Core } from "../core.js";
import { clientIp, parseCidrList } from "../net.js";
import { secretKeyConfigured } from "../secretBox.js";
import { SettingError } from "../settings.js";

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

type Handler = (req: Request, res: Response, admin: PlatformUser) => Promise<unknown> | unknown;

export function adminRouter(core: Core): Router {
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
      const { row, secret } = createToken(core, { name, scope: body.scope, userId: admin.userId, expiresInDays: days });
      record(req, admin, "token-create", row.id, `${name} (${row.scope})`);
      return { token: tokenView(core, row, isAdmin), secret };
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

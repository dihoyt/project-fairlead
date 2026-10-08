import express, { type Request, type Response, type Router } from "express";
import type { AccountView, AuthMethods, LoginResponse, Me } from "../../contracts/auth.js";
import { authOf, currentUser, envAdmin, unauthorizedBody } from "../auth/identity.js";
import { networkAllows } from "../auth/networks.js";
import {
  CALLBACK_PATH,
  OidcError,
  OidcInteractionRequired,
  emailAllowed,
  emailIsAdmin,
  finishSignIn,
  groupAllowed,
  groupIsAdmin,
  oidcUnavailableReason,
  publicIssuer,
  safeReturnTo,
  startSignIn,
  type OidcProfile,
} from "../auth/oidc.js";
import { hashPassword, passwordProblem, verifyPassword } from "../auth/passwords.js";
import {
  createSession,
  dropRequestSession,
  endSession,
  revokeAllSessions,
  sessionDueRecheck,
  sessionHandle,
  sessionsOf,
} from "../auth/sessions.js";
import { createPendingToken, totpEnabledFor } from "../auth/totp.js";
import {
  createUser,
  identitiesOf,
  linkIdentity,
  normalizeUsername,
  recordLogin,
  touchIdentity,
  updateUser,
  userById,
  userByIdentity,
  userByUsername,
  usernameProblem,
  type UserRow,
} from "../auth/users.js";
import { handle, iso, isoOrNull, publicOrigin, type Core } from "../core.js";
import { clientIp } from "../net.js";
import { secretKeyConfigured } from "../secretBox.js";

const GENERIC_FAILURE = "Wrong username or password.";

// /api/me, answered even while a password change is pending, because that
// flag is how the client learns to show the form.
export function meRoute(): express.RequestHandler {
  return (req, res) => {
    const user = currentUser(req);
    if (user === null) {
      res.status(401).json(unauthorizedBody(authOf(req)));
      return;
    }
    const body: Me = {
      id: user.id,
      name: user.name,
      email: user.email,
      groups: user.groups,
      admin: user.admin,
      source: user.source,
      mustChangePassword: user.mustChangePassword,
      ...(user.mustEnrollTotp !== undefined ? { mustEnrollTotp: user.mustEnrollTotp } : {}),
      orgId: user.orgId,
    };
    res.json(body);
  };
}

// JSON routes, mounted at /api/auth.
export function authApiRouter(core: Core): Router {
  const router = express.Router();
  const s = core.settings;
  const { byUser, byIp } = core.limits;

  router.get(
    "/methods",
    handle(async (req, res) => {
      const oidcReady = (await oidcUnavailableReason(core)) === null;
      const body: AuthMethods = {
        siteName: s.string("site.name"),
        password: s.bool("auth.password.enabled"),
        oidc: oidcReady ? { label: s.string("auth.oidc.label") } : null,
        ip: clientIp(req),
      };
      res.json(body);
    })
  );

  router.post(
    "/login",
    handle(async (req, res) => {
      const ip = clientIp(req);
      const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
      const username = typeof body.username === "string" ? normalizeUsername(body.username) : "";
      const password = typeof body.password === "string" ? body.password : "";

      if (!s.bool("auth.password.enabled")) {
        res.status(403).json({ error: "Password sign-in is turned off." });
        return;
      }
      const userKey = `user:${username}`;
      const ipKey = `ip:${ip}`;
      if (byUser.isBlocked(userKey) || byIp.isBlocked(ipKey)) {
        const wait = Math.max(byUser.retryAfterSeconds(userKey), byIp.retryAfterSeconds(ipKey));
        res.status(429).set("Retry-After", String(wait)).json({ error: "Too many attempts. Try again later." });
        return;
      }

      const account = username ? userByUsername(core.db, username) : null;
      const ok = await verifyPassword(account?.passwordHash ?? null, password);
      if (!ok || account === null || account.disabled) {
        byUser.fail(userKey);
        byIp.fail(ipKey);
        core.audit.record({ actor: username, ip, action: "auth.sign-in", detail: "password", result: "denied" });
        res.status(401).json({ error: GENERIC_FAILURE });
        return;
      }
      // Only after the password is right, so a network rule never tells an
      // outsider which usernames exist.
      if (!networkAllows(s, account, "password", ip)) {
        core.audit.record({
          actor: username,
          ip,
          action: "auth.sign-in",
          detail: "password: network not allowed",
          result: "denied",
        });
        res.status(403).json({ error: `This account cannot sign in from ${ip}.` });
        return;
      }
      if (s.bool("auth.totp.enabled") && totpEnabledFor(core, account.id)) {
        // Refused rather than waved through: without the key the code cannot
        // be checked, and skipping it would make losing SECRETS_KEY a way
        // around two-factor.
        if (!secretKeyConfigured()) {
          core.audit.record({
            actor: username,
            ip,
            action: "auth.sign-in",
            detail: "password: SECRETS_KEY missing for two-factor",
            result: "error",
          });
          res.status(503).json({
            error:
              "Two-factor is on for this account but the server has no SECRETS_KEY. An operator can run reset-admin.",
          });
          return;
        }
        // The per-username failure count is left alone until the code is
        // right, so wrong codes and wrong passwords share one budget.
        core.audit.record({
          actor: username,
          ip,
          action: "auth.sign-in",
          detail: "password: awaiting two-factor code",
          result: "ok",
        });
        const pending: LoginResponse = { totpRequired: true, pending: createPendingToken(account) };
        res.json(pending);
        return;
      }
      byUser.reset(userKey);
      createSession(core, res, { userId: account.id, method: "password", ip, userAgent: req.get("user-agent") ?? "" });
      recordLogin(core.db, account.id);
      core.audit.record({ actor: username, ip, action: "auth.sign-in", detail: "password", result: "ok" });
      const done: LoginResponse = { mustChangePassword: account.mustChangePassword };
      res.json(done);
    })
  );

  router.post("/logout", (req, res) => {
    const user = currentUser(req);
    endSession(core, req, res);
    if (user !== null && user.source !== "dev-bypass") {
      core.audit.record({ actor: user.id, ip: clientIp(req), action: "auth.sign-out", result: "ok" });
    }
    res.json({ ok: true });
  });

  // Works while a password change is required, which is the point of it.
  router.post(
    "/password",
    handle(async (req, res) => {
      const user = currentUser(req);
      if (user === null || user.userId === undefined) {
        res.status(401).json(unauthorizedBody(authOf(req)));
        return;
      }
      const account = userById(core.db, user.userId);
      const body = (req.body ?? {}) as { current?: unknown; next?: unknown };
      const current = typeof body.current === "string" ? body.current : "";
      const next = typeof body.next === "string" ? body.next : "";
      const ip = clientIp(req);

      // An account with no password yet (created for OIDC) may set one without
      // a current one; any other has to prove it knows the old one, so a
      // session left open on a shared machine cannot be turned into a takeover.
      if (
        account === null ||
        (account.passwordHash !== null && !(await verifyPassword(account.passwordHash, current)))
      ) {
        core.audit.record({ actor: user.id, ip, action: "auth.password-change", result: "denied" });
        res.status(400).json({ error: "The current password is wrong." });
        return;
      }
      const problem = passwordProblem(next);
      if (problem !== null) {
        res.status(400).json({ error: problem });
        return;
      }
      if (account.passwordHash !== null && (await verifyPassword(account.passwordHash, next))) {
        res.status(400).json({ error: "Choose a password different from the current one." });
        return;
      }
      updateUser(core.db, account.id, { passwordHash: await hashPassword(next), mustChangePassword: false });
      // Every other session ends: a password change is what someone does when
      // they think another person has it.
      const own = sessionsOf(core, account.id).find(
        (session) => user.session !== undefined && sessionHandle(session.idHash) === user.session
      );
      revokeAllSessions(core, account.id, own?.idHash);
      core.audit.record({ actor: user.id, ip, action: "auth.password-change", result: "ok" });
      res.json({ ok: true });
    })
  );

  // The caller's own linked sign-ins and open sessions, for the account
  // page. Available while a password change is pending, like /api/me.
  router.get("/account", (req, res) => {
    const user = currentUser(req);
    if (user === null || user.userId === undefined) {
      res.status(401).json(unauthorizedBody(authOf(req)));
      return;
    }
    const account = userById(core.db, user.userId);
    const body: AccountView = {
      hasPassword: account?.passwordHash != null,
      totpEnabled: totpEnabledFor(core, user.userId),
      totpAvailable: s.bool("auth.totp.enabled") && secretKeyConfigured(),
      identities: identitiesOf(core.db, user.userId).map(({ provider, email, createdAt, lastUsedAt }) => ({
        provider,
        email,
        createdAt: iso(createdAt),
        lastUsedAt: isoOrNull(lastUsedAt),
      })),
      sessions: sessionsOf(core, user.userId).map((session) => ({
        id: sessionHandle(session.idHash),
        method: session.method,
        ip: session.ip,
        userAgent: session.userAgent,
        lastSeenAt: iso(session.lastSeenAt),
        current: user.session === sessionHandle(session.idHash),
      })),
    };
    res.json(body);
  });

  return router;
}

// The username an account created at first sign-in gets: the configured
// claim if it is usable, otherwise the email. Never silently altered to
// dodge a collision: two people must not end up as "alex" and "alex1" by
// accident of who signed in first.
function provisionedUsername(profile: OidcProfile): string | null {
  for (const candidate of [profile.username, profile.email]) {
    const name = normalizeUsername(candidate);
    if (name && usernameProblem(name) === null) return name;
  }
  return null;
}

// Browser navigations for OIDC, mounted at the site root because the
// callback path is what gets registered with the provider.
export function oidcRouter(core: Core): Router {
  const router = express.Router();
  const s = core.settings;

  // A failed re-check ends the session it was re-checking. Left alone, it
  // would answer the next page load with "re-check" again and send the
  // browser straight back to the provider, forever.
  const redirectWithError = (req: Request, res: Response, message: string) => {
    if (sessionDueRecheck(core, req) !== null) endSession(core, req, res);
    res.redirect(303, `${publicOrigin(core)}/#signin-error=${encodeURIComponent(message)}`);
  };

  router.get(
    "/auth/oidc/start",
    handle(async (req, res) => {
      const returnTo = safeReturnTo(req.query.rd);
      let link: number | null = null;
      if (req.query.link !== undefined) {
        const user = currentUser(req);
        if (user === null || user.userId === undefined) {
          redirectWithError(req, res, "Sign in first, then link your account.");
          return;
        }
        link = user.userId;
      }
      // Silent only when there really is a session due a re-check; otherwise
      // prompt=none could only fail.
      const silent = link === null && req.query.recheck !== undefined && sessionDueRecheck(core, req) !== null;
      try {
        const { url } = await startSignIn(core, returnTo, link, { silent });
        res.redirect(303, url);
      } catch (err) {
        const message = err instanceof OidcError ? err.message : "Could not start sign-in.";
        if (!(err instanceof OidcError)) core.log.error("OIDC start failed", { error: (err as Error).message });
        redirectWithError(req, res, message);
      }
    })
  );

  const resolveAccount = (profile: OidcProfile, link: number | null): { account: UserRow } | { error: string } => {
    const linked = userByIdentity(core.db, profile.provider, profile.subject);

    if (link !== null) {
      const target = userById(core.db, link);
      if (target === null) return { error: "The account to link no longer exists." };
      if (linked !== null && linked.id !== target.id) {
        return { error: "That sign-in is already linked to another account." };
      }
      linkIdentity(core.db, profile.provider, profile.subject, target.id, profile.email);
      return { account: target };
    }

    if (linked !== null) return { account: linked };

    // An account an admin created for this person with no password is the
    // one place an unlinked identity may attach itself, matched by username
    // or verified email. Never an account with a password: otherwise anyone
    // whose provider lets them be called "admin" would become this
    // install's admin.
    for (const candidate of [profile.username, profile.emailVerified ? profile.email : ""]) {
      if (!candidate) continue;
      const existing = userByUsername(core.db, candidate);
      if (existing !== null && existing.passwordHash === null) {
        linkIdentity(core.db, profile.provider, profile.subject, existing.id, profile.email);
        return { account: existing };
      }
    }

    if (!s.bool("auth.oidc.autoProvision")) {
      return { error: "There is no account for you here yet. Ask an admin to create one." };
    }
    // Anyone in the world has a Google or Microsoft account; without a list
    // saying who is wanted, creating accounts would let them all in.
    if (
      publicIssuer(s.string("auth.oidc.issuer")) &&
      s.list("auth.oidc.allowedEmails").length === 0 &&
      s.list("auth.oidc.allowedGroups").length === 0
    ) {
      return {
        error:
          "Sign-in is open to anyone with this provider, so no account is created until an admin lists allowed email addresses.",
      };
    }
    const username = provisionedUsername(profile);
    if (username === null) return { error: "Your provider did not send a usable username or email." };
    if (userByUsername(core.db, username) !== null) {
      return { error: `An account named "${username}" already exists. Ask an admin to link it to your sign-in.` };
    }
    const account = createUser(core.db, {
      orgId: core.orgId,
      username,
      displayName: profile.name,
      email: profile.email,
      passwordHash: null,
      role:
        groupIsAdmin(core, profile.groups) ||
        emailIsAdmin(core, profile) ||
        envAdmin([username, profile.email], profile.groups)
          ? "admin"
          : "user",
    });
    linkIdentity(core.db, profile.provider, profile.subject, account.id, profile.email);
    return { account };
  };

  router.get(
    CALLBACK_PATH,
    handle(async (req, res) => {
      const ip = clientIp(req);
      let finished;
      try {
        finished = await finishSignIn(core, req.query as Record<string, unknown>);
      } catch (err) {
        if (err instanceof OidcInteractionRequired) {
          res.redirect(303, `${publicOrigin(core)}/auth/oidc/start?rd=${encodeURIComponent(err.returnTo)}`);
          return;
        }
        const message = err instanceof OidcError ? err.message : "Sign-in failed.";
        if (!(err instanceof OidcError)) core.log.error("OIDC callback failed", { error: (err as Error).message });
        core.audit.record({ actor: "", ip, action: "auth.sign-in", detail: `oidc: ${message}`, result: "error" });
        redirectWithError(req, res, message);
        return;
      }
      const { profile, returnTo, link } = finished;
      const who = profile.username || profile.email || profile.subject;

      if (!groupAllowed(core, profile.groups)) {
        core.audit.record({
          actor: who,
          ip,
          action: "auth.sign-in",
          detail: "oidc: not in an allowed group",
          result: "denied",
        });
        redirectWithError(req, res, "Your account is not in a group allowed to sign in here.");
        return;
      }
      if (!emailAllowed(core, profile)) {
        core.audit.record({
          actor: who,
          ip,
          action: "auth.sign-in",
          detail: profile.emailVerified ? "oidc: email not allowed" : "oidc: no verified email",
          result: "denied",
        });
        redirectWithError(
          req,
          res,
          profile.emailVerified
            ? `${profile.email} is not allowed to sign in here.`
            : "Your provider did not send a verified email address, which this console needs to let you in."
        );
        return;
      }
      const resolved = resolveAccount(profile, link);
      if ("error" in resolved) {
        core.audit.record({
          actor: who,
          ip,
          action: "auth.sign-in",
          detail: `oidc: ${resolved.error}`,
          result: "denied",
        });
        redirectWithError(req, res, resolved.error);
        return;
      }
      const { account } = resolved;
      if (account.disabled) {
        core.audit.record({
          actor: account.username,
          ip,
          action: "auth.sign-in",
          detail: "oidc: account disabled",
          result: "denied",
        });
        redirectWithError(req, res, "This account is disabled.");
        return;
      }
      if (!networkAllows(s, account, "oidc", ip)) {
        core.audit.record({
          actor: account.username,
          ip,
          action: "auth.sign-in",
          detail: "oidc: network not allowed",
          result: "denied",
        });
        redirectWithError(req, res, `This account cannot sign in from ${ip}.`);
        return;
      }

      if (account.role !== "admin" && emailIsAdmin(core, profile)) {
        updateUser(core.db, account.id, { role: "admin" });
        core.audit.record({
          actor: account.username,
          ip,
          action: "auth.oidc.admin-email",
          target: account.username,
          detail: `role=admin from auth.oidc.adminEmails (${profile.email})`,
          result: "ok",
        });
      }
      touchIdentity(core.db, profile.provider, profile.subject, profile.email);
      if (link === null) {
        // The new cookie replaces whatever this browser held, so its row would
        // otherwise linger unreachable; for a re-check it is the overdue
        // session.
        dropRequestSession(core, req);
        createSession(core, res, {
          userId: account.id,
          method: "oidc",
          groups: profile.groups,
          ip,
          userAgent: req.get("user-agent") ?? "",
        });
        recordLogin(core.db, account.id);
      }
      core.audit.record({
        actor: account.username,
        ip,
        action: link === null ? "auth.sign-in" : "auth.identity-link",
        detail: `oidc: ${profile.provider}`,
        result: "ok",
      });
      res.redirect(303, `${publicOrigin(core)}${returnTo}`);
    })
  );

  return router;
}

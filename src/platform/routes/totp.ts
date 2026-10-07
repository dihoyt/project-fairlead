import express, { type Request, type Response, type Router } from "express";
import type { TotpStatus } from "../../contracts/auth.js";
import { authOf, currentUser, unauthorizedBody, type PlatformUser } from "../auth/identity.js";
import type { FailureLimiter } from "../auth/limiter.js";
import { networkAllows } from "../auth/networks.js";
import { verifyPassword } from "../auth/passwords.js";
import { createSession } from "../auth/sessions.js";
import {
  TotpError,
  beginEnrollment,
  clearTotp,
  confirmEnrollment,
  readPendingToken,
  regenerateRecoveryCodes,
  totpEnabledFor,
  totpRequiredFor,
  totpStatus,
  useRecoveryCode,
  verifyTotp,
} from "../auth/totp.js";
import { recordLogin, userById } from "../auth/users.js";
import { handle, type Core } from "../core.js";
import { clientIp } from "../net.js";
import { SecretKeyError, secretKeyConfigured } from "../secretBox.js";

const SIX_DIGITS = /^\d{6}$/;

function throttled(res: Response, keys: [FailureLimiter, string][]): boolean {
  if (!keys.some(([limiter, key]) => limiter.isBlocked(key))) return false;
  const wait = Math.max(...keys.map(([limiter, key]) => limiter.retryAfterSeconds(key)));
  res.status(429).set("Retry-After", String(wait)).json({ error: "Too many attempts. Try again later." });
  return true;
}

// The signed-in password user, or null after answering. An OIDC session's
// second factor is whatever its provider demanded.
function passwordUser(req: Request, res: Response): (PlatformUser & { userId: number }) | null {
  const user = currentUser(req);
  if (user === null || user.userId === undefined) {
    res.status(401).json(unauthorizedBody(authOf(req)));
    return null;
  }
  if (user.source !== "password") {
    res.status(400).json({ error: "Your identity provider handles two-factor." });
    return null;
  }
  return user as PlatformUser & { userId: number };
}

// Two-factor enrolment and verification for the signed-in user, and the
// second step of a password sign-in, mounted at /api/auth/totp. Every route
// here answers while a password change or an enrolment is still owed, since
// this is where the latter gets done.
export function totpRouter(core: Core): Router {
  const router = express.Router();
  const s = core.settings;
  const { byUser, byIp } = core.limits;
  const required = (admin: boolean) =>
    s.bool("auth.totp.enabled") && totpRequiredFor(admin, s.string("auth.totp.require"));

  const fail = (res: Response, err: unknown) => {
    if (err instanceof TotpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof SecretKeyError) {
      res.status(503).json({ error: err.message });
      return;
    }
    core.log.error("Two-factor request failed", { error: (err as Error).message });
    res.status(500).json({ error: "Internal error." });
  };

  // A recovery code comes in its own field, or in the code field: anything
  // there that is not six digits is tried as one.
  router.post("/verify", (req, res) => {
    const ip = clientIp(req);
    const body = (req.body ?? {}) as { pending?: unknown; code?: unknown; recoveryCode?: unknown };
    const pending = typeof body.pending === "string" ? body.pending : "";
    const recoveryCode = typeof body.recoveryCode === "string" ? body.recoveryCode.trim() : "";
    const code = recoveryCode || (typeof body.code === "string" ? body.code.trim() : "");
    const ipKey = `ip:${ip}`;
    try {
      if (!secretKeyConfigured())
        throw new TotpError(503, "Two-factor sign-in needs SECRETS_KEY to be set on the server.");
      const userId = readPendingToken(pending, (id) => userById(core.db, id));
      const account = userId === null ? null : userById(core.db, userId);
      if (account === null) {
        res.status(401).json({ error: "That sign-in has expired. Enter your password again.", restart: true });
        return;
      }
      const userKey = `user:${account.username}`;
      if (
        throttled(res, [
          [byUser, userKey],
          [byIp, ipKey],
        ])
      ) {
        return;
      }
      if (account.disabled || !s.bool("auth.password.enabled") || !totpEnabledFor(core, account.id)) {
        res.status(401).json({ error: "That sign-in has expired. Enter your password again.", restart: true });
        return;
      }
      if (!networkAllows(s, account, "password", ip)) {
        core.audit.record({
          actor: account.username,
          ip,
          action: "auth.sign-in",
          detail: "totp: network not allowed",
          result: "denied",
        });
        res.status(403).json({ error: `This account cannot sign in from ${ip}.` });
        return;
      }
      const usedRecovery = recoveryCode !== "" || !SIX_DIGITS.test(code.replace(/\s/g, ""));
      const ok = usedRecovery ? useRecoveryCode(core, account.id, code) : verifyTotp(core, account.id, code);
      const detail = usedRecovery ? "recovery-code" : "totp";
      if (!ok) {
        byUser.fail(userKey);
        byIp.fail(ipKey);
        core.audit.record({ actor: account.username, ip, action: "auth.sign-in", detail, result: "denied" });
        res.status(401).json({ error: usedRecovery ? "That recovery code is not valid." : "That code is not right." });
        return;
      }
      byUser.reset(userKey);
      createSession(core, res, { userId: account.id, method: "password", ip, userAgent: req.get("user-agent") ?? "" });
      recordLogin(core.db, account.id);
      core.audit.record({ actor: account.username, ip, action: "auth.sign-in", detail, result: "ok" });
      res.json({ mustChangePassword: account.mustChangePassword });
    } catch (err) {
      fail(res, err);
    }
  });

  const requireFeature = () => {
    if (!s.bool("auth.totp.enabled")) throw new TotpError(409, "Two-factor sign-in is turned off here.");
  };

  router.get("/status", (req, res) => {
    const user = passwordUser(req, res);
    if (user === null) return;
    const status = totpStatus(core, user.userId);
    const body: TotpStatus = {
      enabled: status.enabled,
      available: s.bool("auth.totp.enabled") && secretKeyConfigured(),
      required: required(user.admin),
      recoveryCodesLeft: status.recoveryCodesLeft,
    };
    res.json(body);
  });

  router.post("/enroll", (req, res) => {
    const user = passwordUser(req, res);
    if (user === null) return;
    try {
      requireFeature();
      res.json(beginEnrollment(core, user.userId, user.id));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/confirm", (req, res) => {
    const user = passwordUser(req, res);
    if (user === null) return;
    const code = typeof req.body?.code === "string" ? (req.body.code as string) : "";
    const ip = clientIp(req);
    try {
      requireFeature();
      const recoveryCodes = confirmEnrollment(core, user.userId, code);
      core.audit.record({ actor: user.id, ip, action: "auth.totp-enable", result: "ok" });
      res.json({ recoveryCodes });
    } catch (err) {
      if (err instanceof TotpError && err.status === 400) {
        core.audit.record({ actor: user.id, ip, action: "auth.totp-enable", result: "denied" });
      }
      fail(res, err);
    }
  });

  router.post(
    "/disable",
    handle(async (req, res) => {
      const user = passwordUser(req, res);
      if (user === null) return;
      const password = typeof req.body?.password === "string" ? (req.body.password as string) : "";
      const ip = clientIp(req);
      const userKey = `user:${user.id}`;
      if (throttled(res, [[byUser, userKey]])) return;
      if (required(user.admin)) {
        res.status(409).json({ error: "Two-factor is required for your account, so it cannot be turned off." });
        return;
      }
      // The password, not a code: someone who lost the authenticator still
      // knows it, and a session left open does not.
      if (!(await verifyPassword(userById(core.db, user.userId)?.passwordHash ?? null, password))) {
        byUser.fail(userKey);
        core.audit.record({ actor: user.id, ip, action: "auth.totp-disable", result: "denied" });
        res.status(400).json({ error: "The password is wrong." });
        return;
      }
      clearTotp(core, user.userId);
      core.audit.record({ actor: user.id, ip, action: "auth.totp-disable", result: "ok" });
      res.json({ ok: true });
    })
  );

  router.post("/recovery-codes", (req, res) => {
    const user = passwordUser(req, res);
    if (user === null) return;
    const code = typeof req.body?.code === "string" ? (req.body.code as string) : "";
    const ip = clientIp(req);
    const userKey = `user:${user.id}`;
    if (throttled(res, [[byUser, userKey]])) return;
    try {
      if (!verifyTotp(core, user.userId, code)) {
        byUser.fail(userKey);
        core.audit.record({ actor: user.id, ip, action: "auth.totp-recovery-codes", result: "denied" });
        res.status(400).json({ error: "That code is not right." });
        return;
      }
      const recoveryCodes = regenerateRecoveryCodes(core, user.userId);
      core.audit.record({ actor: user.id, ip, action: "auth.totp-recovery-codes", result: "ok" });
      res.json({ recoveryCodes });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}

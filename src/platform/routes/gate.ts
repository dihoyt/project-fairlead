import crypto from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { GATE_EMAIL_HEADER, GATE_FORWARD_PATH, GATE_USER_HEADER } from "../../contracts/platform.js";
import { product } from "../../product.js";
import { currentUser, sessionAdmin, sessionMustEnrollTotp } from "../auth/identity.js";
import { liveSessionByHash, readCookie, requestSessionHash } from "../auth/sessions.js";
import { userById } from "../auth/users.js";
import type { Core } from "../core.js";
import type { PlatformGate } from "../gate.js";
import { clientIp } from "../net.js";

// The sign-in gate. Traefik's forwardAuth asks GATE_FORWARD_PATH about every
// request to a gated app. The console's own session cookie is host-only, so
// an app host never carries it: a browser without the app's own gate cookie
// is sent to /auth/gate on the console, which hands it a single-use ticket
// for that host and sends it to CALLBACK_PATH there. That request reaches
// the forward endpoint too, which swaps the ticket for a grant and answers
// with a redirect carrying the host's cookie; Traefik returns a non-2xx
// answer to the browser as is, Set-Cookie included, and the app never sees
// the ticket.

export const GATE_COOKIE = `${product.cookiePrefix}_gate`;
export const CALLBACK_PATH = `/.${product.cookiePrefix}-gate`;

const TICKET_MS = 2 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const sha = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const random = () => crypto.randomBytes(32).toString("base64url");

function forwarded(req: Request, name: string): string {
  return (req.get(name) ?? "").split(",")[0]!.trim();
}

// Hostnames as the browser addressed them; a port stays part of the host.
const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/;

function wantsPage(req: Request): boolean {
  const method = (forwarded(req, "x-forwarded-method") || "GET").toUpperCase();
  return (method === "GET" || method === "HEAD") && (req.get("accept") ?? "").includes("text/html");
}

function page(res: Response, status: number, text: string): void {
  res.status(status).type("text/plain").send(`${text}\n`);
}

interface Who {
  username: string;
  email: string;
}

// The person behind a console session, when they may open gated apps now.
function allowedFor(core: Core, sessionHash: string): Who | null {
  const session = liveSessionByHash(core, sessionHash);
  if (session === null) return null;
  const account = userById(core.db, session.userId);
  if (account === null || account.disabled || account.mustChangePassword) return null;
  const groups = session.method === "oidc" ? session.groups : [];
  const admin = sessionAdmin(core, account, session.method, groups);
  if (sessionMustEnrollTotp(core, account.id, session.method, admin)) return null;
  if (core.settings.string("auth.gate.allow") !== "everyone" && !admin) return null;
  return { username: account.username, email: account.email };
}

function cookie(value: string, maxAgeMs: number, secure: boolean): string {
  const attributes = [
    `${GATE_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    // Lax: the round trip ends in a top-level redirect from the console.
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

// Mounted ahead of the platform's session lookup: these requests come from
// Traefik with the app's cookies, never the console's, and nothing about
// the console session may be written onto an answer Traefik passes back.
export function gateForwardRouter(core: Core, gate: PlatformGate): Router {
  const router = express.Router();

  router.all(GATE_FORWARD_PATH, (req, res) => {
    res.set("Cache-Control", "no-store");
    const host = forwarded(req, "x-forwarded-host").toLowerCase();
    const uri = forwarded(req, "x-forwarded-uri") || "/";
    if (!HOST.test(host) || !uri.startsWith("/")) {
      page(res, 401, "Sign-in required.");
      return;
    }
    const asked = typeof req.query.proto === "string" ? req.query.proto : "";
    const proto = asked === "https" || asked === "http" ? asked : forwarded(req, "x-forwarded-proto") || "http";
    const secure = proto === "https";
    const url = new URL(uri, `${proto}://${host}`);

    if (url.pathname === CALLBACK_PATH) {
      const ticket = url.searchParams.get("ticket") ?? "";
      const now = Date.now();
      const row = core.db
        .prepare("SELECT session_hash, host, return_path, expires_at FROM gate_tickets WHERE ticket_hash = ?")
        .get(sha(ticket)) as
        { session_hash: string; host: string; return_path: string; expires_at: number } | undefined;
      if (row) core.db.prepare("DELETE FROM gate_tickets WHERE ticket_hash = ?").run(sha(ticket));
      const who = row && row.host === host && row.expires_at > now ? allowedFor(core, row.session_hash) : null;
      if (!row || !who) {
        page(res, 403, "That sign-in link has expired or was already used. Open the app's address again.");
        return;
      }
      const grant = random();
      const session = liveSessionByHash(core, row.session_hash)!;
      const expiresAt = Math.min(session.expiresAt, now + core.settings.number("auth.session.maxDays") * DAY);
      core.db
        .prepare(
          `INSERT INTO gate_grants (grant_hash, org_id, session_hash, host, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(sha(grant), core.orgId, row.session_hash, host, now, expiresAt);
      core.db.prepare("DELETE FROM gate_grants WHERE expires_at <= ?").run(now);
      res.set("Set-Cookie", cookie(grant, expiresAt - now, secure));
      res.redirect(302, row.return_path);
      return;
    }

    if (req.query.credentials === "1" && req.get("authorization")) {
      res.status(200).end();
      return;
    }

    const grant = readCookie(req, GATE_COOKIE);
    if (grant) {
      const row = core.db
        .prepare("SELECT session_hash FROM gate_grants WHERE grant_hash = ? AND host = ? AND expires_at > ?")
        .get(sha(grant), host, Date.now()) as { session_hash: string } | undefined;
      const who = row ? allowedFor(core, row.session_hash) : null;
      if (who) {
        res.set(GATE_USER_HEADER, who.username).set(GATE_EMAIL_HEADER, who.email).status(200).end();
        return;
      }
    }

    if (!wantsPage(req)) {
      if (req.query.credentials === "1") res.set("WWW-Authenticate", `Basic realm="${host}"`);
      page(res, 401, "Sign-in required.");
      return;
    }
    const readiness = gate.readiness();
    if (!readiness.ready) {
      page(res, 503, `This app is behind the console's sign-in, which can't send you to sign in: ${readiness.reason}`);
      return;
    }
    const rd = `${proto}://${host}${uri}`;
    res.redirect(302, `${readiness.signInUrl}/auth/gate?rd=${encodeURIComponent(rd)}`);
  });

  return router;
}

// Where the round trip starts, on the console's own address. Mounted after
// the session lookup.
export function gateRouter(core: Core, gate: PlatformGate): Router {
  const router = express.Router();

  router.get("/auth/gate", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    let target: URL;
    try {
      target = new URL(typeof req.query.rd === "string" ? req.query.rd : "");
    } catch {
      page(res, 400, "Missing or malformed address to return to.");
      return;
    }
    if ((target.protocol !== "https:" && target.protocol !== "http:") || target.username || target.password) {
      page(res, 400, "Missing or malformed address to return to.");
      return;
    }
    gate
      .allows(target.hostname)
      .then((allowed) => {
        if (!allowed) {
          page(res, 400, `${target.hostname} is not an app this console signs people in to.`);
          return;
        }
        const user = currentUser(req);
        const sessionHash = requestSessionHash(req);
        if (user === null || user.mustChangePassword || user.mustEnrollTotp) {
          // The client signs in (or finishes a password change) first, then
          // comes back here.
          res.redirect(302, `../#/gate?rd=${encodeURIComponent(target.toString())}`);
          return;
        }
        if (sessionHash === null || (user.source !== "password" && user.source !== "oidc")) {
          page(res, 403, "Opening apps behind the console's sign-in takes a signed-in session.");
          return;
        }
        if (allowedFor(core, sessionHash) === null) {
          page(res, 403, `Only admins can open apps behind the console's sign-in; ${user.id} is not one.`);
          return;
        }
        const ticket = random();
        const now = Date.now();
        core.db.prepare("DELETE FROM gate_tickets WHERE expires_at <= ?").run(now);
        core.db
          .prepare(
            `INSERT INTO gate_tickets (ticket_hash, org_id, session_hash, host, return_path, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            sha(ticket),
            core.orgId,
            sessionHash,
            target.host,
            `${target.pathname}${target.search}`,
            now + TICKET_MS
          );
        core.audit.record({ actor: user.id, ip: clientIp(req), action: "auth.gate-open", target: target.host });
        res.redirect(302, `${target.protocol}//${target.host}${CALLBACK_PATH}?ticket=${encodeURIComponent(ticket)}`);
      })
      .catch(next);
  });

  return router;
}

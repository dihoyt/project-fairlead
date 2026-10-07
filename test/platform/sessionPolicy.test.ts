import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { sessionStanding, type SessionRow } from "../../src/platform/auth/sessions.js";
import type { Core } from "../../src/platform/core.js";
import { boot, configureOidc, cookieFrom, fakeIssuer, oidcSignIn, type Booted, type FakeIssuer } from "./harness.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

let issuer: FakeIssuer;
let app: Booted;
let core: Core;

before(async () => {
  issuer = await fakeIssuer();
});
after(() => issuer.close());

beforeEach(async () => {
  app = await boot();
  core = { db: app.db, settings: app.settings } as Core;
  await configureOidc(app, issuer);
});
afterEach(() => app.close());

function row(extra: Partial<SessionRow>): SessionRow {
  const now = Date.now();
  return {
    idHash: "x",
    userId: 1,
    method: "password",
    groups: [],
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + DAY,
    ip: "",
    userAgent: "",
    oidcCheckedAt: null,
    ...extra,
  };
}

function age(ms: number): void {
  app.db.prepare("UPDATE sessions SET created_at = created_at - ?, oidc_checked_at = oidc_checked_at - ?").run(ms, ms);
}

const sessionCount = () => (app.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;

test("a session older than auth.session.maxDays is over, however recently used", () => {
  app.settings.set("auth.session.maxDays", 7, "test");
  const now = Date.now();
  assert.equal(sessionStanding(core, row({ createdAt: now - 6 * DAY, lastSeenAt: now }), now), "ok");
  assert.equal(sessionStanding(core, row({ createdAt: now - 8 * DAY, lastSeenAt: now }), now), "expired");
});

test("only OIDC sessions are re-checked, and only when recheckHours is on", () => {
  const now = Date.now();
  const old = { createdAt: now - 5 * HOUR };
  assert.equal(sessionStanding(core, row({ ...old, method: "oidc", oidcCheckedAt: now - 5 * HOUR }), now), "ok");
  app.settings.set("auth.oidc.recheckHours", 4, "test");
  assert.equal(sessionStanding(core, row({ ...old, method: "oidc", oidcCheckedAt: now - 5 * HOUR }), now), "recheck");
  assert.equal(sessionStanding(core, row({ ...old, method: "oidc", oidcCheckedAt: null }), now), "recheck");
  assert.equal(sessionStanding(core, row({ ...old, method: "oidc", oidcCheckedAt: now - HOUR }), now), "ok");
  assert.equal(sessionStanding(core, row({ ...old, method: "password" }), now), "ok");
});

test("an expired password session answers a plain 401 and its row is gone", async () => {
  app.settings.set("auth.session.maxDays", 1, "test");
  await app.makeUser("pat", "correct horse battery");
  const { cookie } = await app.login("pat", "correct horse battery");
  assert.equal((await app.get("/api/me", cookie)).status, 200);
  age(2 * DAY);
  const res = await app.get("/api/me", cookie);
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { reauth?: boolean }).reauth, undefined);
  assert.equal(sessionCount(), 0);
});

test("an overdue OIDC session is told to re-check, and the re-check is silent and replaces it", async () => {
  app.settings.set("auth.oidc.recheckHours", 4, "test");
  await app.makeUser("quinn", null);
  const first = (await oidcSignIn(app, issuer, { sub: "s-q", preferred_username: "quinn" })).cookie;
  assert.ok(first);
  age(5 * HOUR);

  for (const route of ["/api/me", "/api/system/modules"]) {
    const res = await app.get(route, first);
    assert.equal(res.status, 401, route);
    assert.equal(((await res.json()) as { reauth?: boolean }).reauth, true, route);
  }

  const recheck = await oidcSignIn(
    app,
    issuer,
    { sub: "s-q", preferred_username: "quinn" },
    { cookie: first, start: "/auth/oidc/start?recheck=1&rd=%2Fsomewhere" }
  );
  assert.equal(recheck.authorize.searchParams.get("prompt"), "none");
  assert.equal(recheck.location, `${app.url}/somewhere`);
  assert.ok(recheck.cookie && recheck.cookie !== first);
  assert.equal((await app.get("/api/me", recheck.cookie)).status, 200);
  assert.equal(sessionCount(), 1);
});

test("a silent re-check the provider cannot complete falls back to an interactive sign-in", async () => {
  app.settings.set("auth.oidc.recheckHours", 4, "test");
  await app.makeUser("rae", null);
  const cookie = (await oidcSignIn(app, issuer, { sub: "s-r", preferred_username: "rae" })).cookie;
  age(5 * HOUR);
  const start = await fetch(`${app.url}/auth/oidc/start?recheck=1&rd=%2Fback`, {
    redirect: "manual",
    headers: { cookie },
  });
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  const callback = await fetch(`${app.url}/auth/oidc/callback?error=login_required&state=${state}`, {
    redirect: "manual",
    headers: { cookie },
  });
  const next = new URL(callback.headers.get("location")!);
  assert.equal(next.pathname, "/auth/oidc/start");
  assert.equal(next.searchParams.get("rd"), "/back");
  assert.equal(next.searchParams.get("recheck"), null);
  const interactive = await fetch(next, { redirect: "manual", headers: { cookie } });
  assert.equal(new URL(interactive.headers.get("location")!).searchParams.get("prompt"), null);
});

test("someone the provider no longer lets in is signed out by the re-check", async () => {
  app.settings.set("auth.oidc.recheckHours", 4, "test");
  await app.makeUser("sam", null);
  const cookie = (await oidcSignIn(app, issuer, { sub: "s-s", preferred_username: "sam", groups: ["staff"] })).cookie;
  age(5 * HOUR);
  app.settings.set("auth.oidc.allowedGroups", ["staff"], "test");

  const recheck = await oidcSignIn(
    app,
    issuer,
    { sub: "s-s", preferred_username: "sam", groups: [] },
    { cookie, start: "/auth/oidc/start?recheck=1" }
  );
  assert.match(decodeURIComponent(recheck.location), /signin-error=.*not in a group/);
  assert.ok(recheck.callback.headers.getSetCookie().some((line) => line.includes("Max-Age=0")));
  assert.equal(cookieFrom(recheck.callback), "");
  assert.equal(sessionCount(), 0);
  const res = await app.get("/api/me", cookie);
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { reauth?: boolean }).reauth, undefined);
});

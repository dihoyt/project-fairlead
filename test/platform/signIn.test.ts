// Real sessions end to end: every request here goes through the platform's
// own cookie, never a test identity hook.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Request } from "express";
import { updateUser, userByUsername, identitiesOf } from "../../src/platform/auth/users.js";
import { verifyPassword } from "../../src/platform/auth/passwords.js";
import { cidrContains, clientIp, parseCidr, parseCidrList } from "../../src/platform/net.js";
import { sessionCookieName } from "../../src/product.js";
import { boot, configureOidc, fakeIssuer, oidcSignIn, type FakeIssuer } from "./harness.js";

let issuer: FakeIssuer;
before(async () => {
  issuer = await fakeIssuer();
});
after(() => issuer.close());

async function withApp(fn: (app: Awaited<ReturnType<typeof boot>>) => Promise<void>, env?: Record<string, string>) {
  const app = await boot(env ? { env } : {});
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

test("without a session the API answers 401", () =>
  withApp(async (app) => {
    assert.equal((await app.get("/api/me")).status, 401);
    assert.equal((await app.get("/api/system/modules")).status, 401);
  }));

test("forwarded identity headers sign nobody in", () =>
  withApp(async (app) => {
    const res = await app.get("/api/me", "", {
      "x-forwarded-user": "admin",
      "x-forwarded-email": "admin@example.test",
    });
    assert.equal(res.status, 401);
  }));

test("a correct password signs in; the cookie identifies the account", () =>
  withApp(async (app) => {
    await app.makeUser("alice", "correct horse battery");
    const { res, cookie } = await app.login("Alice", "correct horse battery");
    assert.equal(res.status, 200);
    assert.ok(cookie.startsWith(`${sessionCookieName}=`));
    const me = (await (await app.get("/api/me", cookie)).json()) as Record<string, unknown>;
    assert.equal(me.id, "alice");
    assert.equal(me.source, "password");
    assert.equal(me.admin, false);
    assert.equal(me.orgId, "default");
    assert.equal((await app.get("/api/system/modules", cookie)).status, 200);
  }));

test("a wrong password and an unknown user get the same answer", () =>
  withApp(async (app) => {
    await app.makeUser("bob", "correct horse battery");
    const wrong = await app.login("bob", "nope nope nope");
    const unknown = await app.login("nobody-here", "nope nope nope");
    assert.equal(wrong.res.status, 401);
    assert.equal(unknown.res.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
    assert.equal(wrong.cookie, "");
  }));

test("repeated failures for one username are throttled", () =>
  withApp(async (app) => {
    await app.makeUser("carol", "correct horse battery");
    for (let i = 0; i < 5; i += 1) await app.login("carol", "wrong password!");
    assert.equal((await app.login("carol", "correct horse battery")).res.status, 429);
  }));

test("a disabled account cannot sign in, and its open sessions stop working", () =>
  withApp(async (app) => {
    const user = await app.makeUser("dave", "correct horse battery");
    const { cookie } = await app.login("dave", "correct horse battery");
    updateUser(app.db, user.id, { disabled: true });
    assert.equal((await app.get("/api/me", cookie)).status, 401);
    assert.equal((await app.login("dave", "correct horse battery")).res.status, 401);
  }));

test("a required password change blocks the API until it is done, then signs out other sessions", () =>
  withApp(async (app) => {
    await app.makeUser("erin", "first password!!", { mustChangePassword: true });
    const first = await app.login("erin", "first password!!");
    const second = await app.login("erin", "first password!!");
    assert.equal(first.body.mustChangePassword, true);

    const blocked = await app.get("/api/system/modules", first.cookie);
    assert.equal(blocked.status, 403);
    assert.equal(((await blocked.json()) as { mustChangePassword?: boolean }).mustChangePassword, true);

    const tooShort = await app.send(
      "POST",
      "/api/auth/password",
      { current: "first password!!", next: "short" },
      first.cookie
    );
    assert.equal(tooShort.status, 400);

    const changed = await app.send(
      "POST",
      "/api/auth/password",
      { current: "first password!!", next: "a much better password" },
      first.cookie
    );
    assert.equal(changed.status, 200);
    const me = (await (await app.get("/api/me", first.cookie)).json()) as Record<string, unknown>;
    assert.equal(me.mustChangePassword, false);
    assert.equal((await app.get("/api/system/modules", first.cookie)).status, 200);
    assert.equal((await app.get("/api/me", second.cookie)).status, 401);
  }));

test("logout ends the session", () =>
  withApp(async (app) => {
    await app.makeUser("fay", "correct horse battery");
    const { cookie } = await app.login("fay", "correct horse battery");
    await app.send("POST", "/api/auth/logout", undefined, cookie);
    assert.equal((await app.get("/api/me", cookie)).status, 401);
  }));

test("a user's own network rule refuses sign-in from elsewhere and is audited", () =>
  withApp(async (app) => {
    const user = await app.makeUser("hana", "correct horse battery");
    updateUser(app.db, user.id, { allowedNetworks: ["192.0.2.0/24"] });
    assert.equal((await app.login("hana", "correct horse battery")).res.status, 403);
    const row = app.db.prepare("SELECT * FROM audit_log WHERE username = 'hana' ORDER BY id DESC").get() as {
      result: string;
      detail: string;
      action: string;
    };
    assert.equal(row.action, "auth.sign-in");
    assert.equal(row.result, "denied");
    assert.match(row.detail, /network/);

    updateUser(app.db, user.id, { allowedNetworks: ["127.0.0.0/8"] });
    assert.equal((await app.login("hana", "correct horse battery")).res.status, 200);
  }));

test("a rule added after sign-in stops the existing session, audited once", () =>
  withApp(async (app) => {
    const user = await app.makeUser("iris", "correct horse battery");
    const { cookie } = await app.login("iris", "correct horse battery");
    updateUser(app.db, user.id, { allowedNetworks: ["192.0.2.0/24"] });
    assert.equal((await app.get("/api/me", cookie)).status, 401);
    assert.equal((await app.get("/api/me", cookie)).status, 401);
    const rows = app.db
      .prepare("SELECT * FROM audit_log WHERE username = 'iris' AND action = 'auth.network-denied'")
      .all() as { result: string; target: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.target, "session");
  }));

test("a method-wide rule applies to users without their own, and a user's rule overrides it", () =>
  withApp(async (app) => {
    app.settings.set("auth.password.networks", ["192.0.2.0/24"], "test");
    await app.makeUser("jo", "correct horse battery");
    assert.equal((await app.login("jo", "correct horse battery")).res.status, 403);
    const kim = await app.makeUser("kim", "correct horse battery");
    updateUser(app.db, kim.id, { allowedNetworks: ["127.0.0.1"] });
    assert.equal((await app.login("kim", "correct horse battery")).res.status, 200);
  }));

test("a client-IP header is ignored unless the peer is a trusted proxy", () =>
  withApp(async (app) => {
    const user = await app.makeUser("lee", "correct horse battery");
    updateUser(app.db, user.id, { allowedNetworks: ["203.0.113.7"] });
    process.env.CLIENT_IP_HEADER = "cf-connecting-ip";
    process.env.TRUSTED_PROXIES = "10.0.0.0/8";
    const claim = { "cf-connecting-ip": "203.0.113.7" };
    assert.equal((await app.login("lee", "correct horse battery", claim)).res.status, 403);
    process.env.TRUSTED_PROXIES = "127.0.0.0/8";
    assert.equal((await app.login("lee", "correct horse battery", claim)).res.status, 200);
  }));

const forwardedRequest = (xff: string) =>
  ({ headers: { "x-forwarded-for": xff }, socket: { remoteAddress: "::ffff:10.1.2.3" } }) as unknown as Request;

test("x-forwarded-for is read from the right, skipping trusted hops", () => {
  const trust = { header: "x-forwarded-for" as const, proxies: parseCidrList(["10.0.0.0/8"]) };
  assert.equal(clientIp(forwardedRequest("6.6.6.6, 198.51.100.4, 10.9.9.9"), trust), "198.51.100.4");
  assert.equal(clientIp(forwardedRequest("198.51.100.4"), { ...trust, proxies: [] }), "10.1.2.3");
});

test("CIDR matching covers IPv4, IPv6 and mapped addresses", () => {
  assert.ok(cidrContains(parseCidr("10.0.0.0/8")!, "10.250.1.1"));
  assert.ok(!cidrContains(parseCidr("10.0.0.0/8")!, "11.0.0.1"));
  assert.ok(cidrContains(parseCidr("192.168.1.0/25")!, "::ffff:192.168.1.100"));
  assert.ok(!cidrContains(parseCidr("192.168.1.0/25")!, "192.168.1.200"));
  assert.ok(cidrContains(parseCidr("2001:db8::/32")!, "2001:db8:abcd::1"));
  assert.ok(!cidrContains(parseCidr("2001:db8::/32")!, "2001:db9::1"));
  assert.equal(parseCidr("10.0.0.0/33"), null);
  assert.equal(parseCidr("not-an-ip"), null);
});

test("a cross-origin mutation is refused even with a valid session", () =>
  withApp(async (app) => {
    await app.makeUser("max", "correct horse battery");
    const { cookie } = await app.login("max", "correct horse battery");
    const res = await fetch(`${app.url}/api/auth/logout`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    });
    assert.equal(res.status, 403);
    assert.equal((await app.get("/api/me", cookie)).status, 200);
  }));

test("the development bypass needs DEV_AUTH and a non-production NODE_ENV", async () => {
  await withApp(
    async (app) => {
      const me = (await (await app.get("/api/me")).json()) as Record<string, unknown>;
      assert.equal(me.source, "dev-bypass");
      assert.equal(me.admin, true);
    },
    { DEV_AUTH: "1" }
  );
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await withApp(async (app) => assert.equal((await app.get("/api/me")).status, 401), { DEV_AUTH: "1" });
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
});

test("ADMIN_USERS makes a named account an admin", () =>
  withApp(
    async (app) => {
      await app.makeUser("boss", "correct horse battery");
      const { cookie } = await app.login("boss", "correct horse battery");
      assert.equal(((await (await app.get("/api/me", cookie)).json()) as { admin: boolean }).admin, true);
      assert.equal((await app.get("/api/system/jobs", cookie)).status, 200);
    },
    { ADMIN_USERS: "Boss" }
  ));

test("OIDC sign-in with no matching account is refused unless auto-provisioning is on", () =>
  withApp(async (app) => {
    await configureOidc(app, issuer);
    const claims = { sub: "s-1", preferred_username: "nina@example.test", email: "nina@example.test" };
    const refused = await oidcSignIn(app, issuer, claims);
    assert.match(decodeURIComponent(refused.location), /no account for you/i);
    assert.equal(refused.cookie, "");

    app.settings.set("auth.oidc.autoProvision", true, "test");
    const ok = await oidcSignIn(app, issuer, { ...claims, groups: ["eng"] });
    assert.equal(ok.authorize.searchParams.get("code_challenge_method"), "S256");
    assert.ok(ok.cookie);
    const me = (await (await app.get("/api/me", ok.cookie)).json()) as Record<string, unknown>;
    assert.equal(me.id, "nina@example.test");
    assert.equal(me.source, "oidc");
    assert.deepEqual(me.groups, ["eng"]);
  }));

test("an OIDC identity never attaches itself to an account that has a password", () =>
  withApp(async (app) => {
    await configureOidc(app, issuer, { "auth.oidc.autoProvision": true });
    await app.makeUser("admin", "correct horse battery", { role: "admin" });
    const res = await oidcSignIn(app, issuer, { sub: "attacker", preferred_username: "admin" });
    assert.match(decodeURIComponent(res.location), /already exists/);
    assert.equal(res.cookie, "");
  }));

test("an admin-created account without a password is claimed by the matching OIDC sign-in", () =>
  withApp(async (app) => {
    await configureOidc(app, issuer);
    await app.makeUser("oscar@example.test", null);
    const res = await oidcSignIn(app, issuer, { sub: "s-oscar", preferred_username: "oscar@example.test" });
    assert.ok(res.cookie);
    assert.equal(identitiesOf(app.db, userByUsername(app.db, "oscar@example.test")!.id).length, 1);
  }));

test("a signed-in user links an OIDC identity to their own account, then signs in with it", () =>
  withApp(async (app) => {
    await configureOidc(app, issuer);
    await app.makeUser("admin", "correct horse battery", { role: "admin" });
    const { cookie } = await app.login("admin", "correct horse battery");
    const claims = { sub: "s-admin", preferred_username: "someone.else@example.test" };
    const linked = await oidcSignIn(app, issuer, claims, { cookie, link: true });
    assert.equal(linked.callback.status, 303);
    assert.ok(!linked.location.includes("signin-error"), linked.location);

    const viaOidc = await oidcSignIn(app, issuer, claims);
    const me = (await (await app.get("/api/me", viaOidc.cookie)).json()) as Record<string, unknown>;
    assert.equal(me.id, "admin");
    assert.equal(me.admin, true);
  }));

test("allowed and admin groups are applied from the provider's claims", () =>
  withApp(async (app) => {
    await configureOidc(app, issuer, {
      "auth.oidc.autoProvision": true,
      "auth.oidc.allowedGroups": ["staff"],
      "auth.oidc.adminGroups": ["ops"],
    });
    const outsider = await oidcSignIn(app, issuer, { sub: "s-p", preferred_username: "pat", groups: ["guests"] });
    assert.match(decodeURIComponent(outsider.location), /not in a group/);
    const op = await oidcSignIn(app, issuer, { sub: "s-q", preferred_username: "quinn", groups: ["staff", "ops"] });
    const me = (await (await app.get("/api/me", op.cookie)).json()) as Record<string, unknown>;
    assert.equal(me.admin, true);
    // Group-derived admin is an admin to modules too.
    assert.equal((await app.get("/api/system/jobs", op.cookie)).status, 200);
  }));

test("an OIDC state is single-use and a wrong nonce is refused", () =>
  withApp(async (app) => {
    await configureOidc(app, issuer, { "auth.oidc.autoProvision": true });
    const start = await fetch(`${app.url}/auth/oidc/start`, { redirect: "manual" });
    const authorize = new URL(start.headers.get("location")!);
    issuer.setNonce("not-the-nonce");
    issuer.next({ sub: "s-r", preferred_username: "rae" });
    const state = authorize.searchParams.get("state");
    const first = await fetch(`${app.url}/auth/oidc/callback?code=abc&state=${state}`, { redirect: "manual" });
    assert.match(decodeURIComponent(first.headers.get("location")!), /nonce/);
    const replay = await fetch(`${app.url}/auth/oidc/callback?code=abc&state=${state}`, { redirect: "manual" });
    assert.match(decodeURIComponent(replay.headers.get("location")!), /expired or was already used/);
  }));

test("the sign-in page learns which methods are on", () =>
  withApp(async (app) => {
    const initial = (await (await app.get("/api/auth/methods")).json()) as Record<string, unknown>;
    assert.equal(initial.password, true);
    assert.equal(initial.oidc, null);
    await configureOidc(app, issuer, { "auth.oidc.label": "Sign in with Example" });
    const configured = (await (await app.get("/api/auth/methods")).json()) as { oidc: { label: string } };
    assert.equal(configured.oidc.label, "Sign in with Example");
  }));

test("the first boot creates admin from BOOTSTRAP_ADMIN_PASSWORD, which must then be changed", async () => {
  await withApp(
    async (app) => {
      const admin = userByUsername(app.db, "admin")!;
      assert.equal(admin.role, "admin");
      assert.equal(admin.mustChangePassword, true);
      const { body } = await app.login("admin", "bootstrap pass 123");
      assert.equal(body.mustChangePassword, true);
    },
    { BOOTSTRAP_ADMIN_PASSWORD: "bootstrap pass 123" }
  );
});

test("the bootstrap password is ignored once any account exists", async () => {
  const { bootstrapAdmin } = await import("../../src/platform/bootstrap.js");
  await withApp(
    async (app) => {
      process.env.BOOTSTRAP_ADMIN_PASSWORD = "a different one!!";
      bootstrapAdmin({ db: app.db, orgId: "default", log: { info() {}, warn() {}, error() {} } } as never);
      assert.ok(await verifyPassword(userByUsername(app.db, "admin")!.passwordHash, "bootstrap pass 123"));
    },
    { BOOTSTRAP_ADMIN_PASSWORD: "bootstrap pass 123" }
  );
});

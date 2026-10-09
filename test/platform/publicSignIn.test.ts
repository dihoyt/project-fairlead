import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import type { PublicSignInResult } from "../../src/contracts/auth.js";
import {
  MICROSOFT_COMMON_ISSUER,
  checkIdTokenClaims,
  discover,
  emailListed,
  emailVerified,
  microsoftMultiTenant,
  publicIssuer,
} from "../../src/platform/auth/oidc.js";
import { userByUsername } from "../../src/platform/auth/users.js";
import { boot, configureOidc, fakeIssuer, oidcSignIn, type Booted, type FakeIssuer } from "./harness.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const CONSUMERS = "9188040d-6c67-4c5b-b112-36a304b66dad";
const TEMPLATE = "https://login.microsoftonline.com/{tenantid}/v2.0";

// Discovery documents as Google and Microsoft publish them, served in place
// of the real hosts.
const realFetch = globalThis.fetch;
function discoveryFor(url: string): Record<string, unknown> | null {
  if (url === "https://accounts.google.com/.well-known/openid-configuration")
    return {
      issuer: "https://accounts.google.com",
      authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      token_endpoint: "https://oauth2.googleapis.com/token",
      userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo",
    };
  const ms =
    /^https:\/\/login\.microsoftonline\.com\/(common|organizations|consumers)\/v2\.0\/\.well-known\/openid-configuration$/.exec(
      url
    );
  if (ms)
    return {
      issuer: ms[1] === "consumers" ? `https://login.microsoftonline.com/${CONSUMERS}/v2.0` : TEMPLATE,
      authorization_endpoint: `https://login.microsoftonline.com/${ms[1]}/oauth2/v2.0/authorize`,
      token_endpoint: `https://login.microsoftonline.com/${ms[1]}/oauth2/v2.0/token`,
      userinfo_endpoint: "https://graph.microsoft.com/oidc/userinfo",
    };
  return null;
}
before(() => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const doc = discoveryFor(String(input instanceof Request ? input.url : input));
    if (doc) return new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } });
    return realFetch(input, init);
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

test("Microsoft's multi-tenant endpoints are recognised, a single tenant is not", () => {
  assert.equal(microsoftMultiTenant(MICROSOFT_COMMON_ISSUER), true);
  assert.equal(microsoftMultiTenant("https://login.microsoftonline.com/organizations/v2.0/"), true);
  assert.equal(microsoftMultiTenant("https://login.microsoftonline.com/consumers/v2.0"), true);
  assert.equal(microsoftMultiTenant(`https://login.microsoftonline.com/${TENANT}/v2.0`), false);
  assert.equal(microsoftMultiTenant("http://login.microsoftonline.com/common/v2.0"), false);
  assert.equal(publicIssuer("https://accounts.google.com/"), true);
  assert.equal(publicIssuer("https://auth.example.test/application/o/console/"), false);
});

test("discovery accepts Microsoft's templated issuer for common, and the consumer tenant for consumers", async () => {
  assert.equal((await discover(MICROSOFT_COMMON_ISSUER)).issuer, TEMPLATE);
  assert.equal(
    (await discover("https://login.microsoftonline.com/consumers/v2.0")).issuer,
    `https://login.microsoftonline.com/${CONSUMERS}/v2.0`
  );
  assert.equal((await discover("https://accounts.google.com")).issuer, "https://accounts.google.com");
});

test("a templated issuer is checked against the token's own tenant", () => {
  const now = Date.now();
  const base = { aud: "app", nonce: "n", sub: "s", exp: Math.floor(now / 1000) + 60 };
  const expected = { issuer: TEMPLATE, clientId: "app", nonce: "n" };
  checkIdTokenClaims({ ...base, tid: TENANT, iss: `https://login.microsoftonline.com/${TENANT}/v2.0` }, expected, now);
  assert.throws(
    () =>
      checkIdTokenClaims(
        { ...base, tid: TENANT, iss: `https://login.microsoftonline.com/${CONSUMERS}/v2.0` },
        expected,
        now
      ),
    /issuer mismatch/
  );
  assert.throws(() => checkIdTokenClaims({ ...base, iss: TEMPLATE }, expected, now), /issuer mismatch/);
  assert.throws(
    () => checkIdTokenClaims({ ...base, tid: "{tenantid}", iss: TEMPLATE }, expected, now),
    /issuer mismatch/
  );
});

test("Microsoft email counts as verified only for personal accounts or with xms_edov", () => {
  assert.equal(emailVerified(TEMPLATE, { tid: CONSUMERS, email: "a@outlook.com" }), true);
  assert.equal(emailVerified(TEMPLATE, { tid: TENANT, email: "ceo@example.com" }), false);
  assert.equal(emailVerified(TEMPLATE, { tid: TENANT, email_verified: true }), false);
  assert.equal(emailVerified(TEMPLATE, { tid: TENANT, xms_edov: true }), true);
  assert.equal(emailVerified("https://accounts.google.com", { email_verified: true }), true);
  assert.equal(emailVerified("https://accounts.google.com", {}), false);
  assert.equal(emailVerified("https://auth.example.test/application/o/console/", {}), true);
});

test("allow-list entries match an address or a whole domain, never a suffix", () => {
  const list = ["ann@example.com", "@example.org", "example.net"];
  assert.equal(emailListed(list, "Ann@Example.com"), true);
  assert.equal(emailListed(list, "bob@example.com"), false);
  assert.equal(emailListed(list, "bob@example.org"), true);
  assert.equal(emailListed(list, "bob@evil-example.org"), false);
  assert.equal(emailListed(list, "bob@sub.example.net"), false);
  assert.equal(emailListed(list, "carol@example.net"), true);
  assert.equal(emailListed(list, ""), false);
});

let issuer: FakeIssuer;
before(async () => {
  issuer = await fakeIssuer();
});
after(() => issuer.close());

test("with an allow list only listed verified addresses sign in, and admin emails become admins", async () => {
  const app = await boot();
  try {
    await configureOidc(app, issuer, {
      "auth.oidc.autoProvision": true,
      "auth.oidc.allowedEmails": ["@example.test"],
      "auth.oidc.adminEmails": ["boss@example.test"],
    });
    const outsider = await oidcSignIn(app, issuer, { sub: "o", email: "eve@elsewhere.test" });
    assert.equal(outsider.cookie, "");
    assert.match(decodeURIComponent(outsider.location), /not allowed to sign in/);

    const unverified = await oidcSignIn(app, issuer, { sub: "u", email: "ann@example.test", email_verified: false });
    assert.equal(unverified.cookie, "");

    const member = await oidcSignIn(app, issuer, {
      sub: "m",
      preferred_username: "ann",
      email: "ann@example.test",
    });
    assert.ok(member.cookie);
    assert.equal(userByUsername(app.db, "ann")?.role, "user");

    const boss = await oidcSignIn(app, issuer, { sub: "b", preferred_username: "boss", email: "boss@example.test" });
    assert.ok(boss.cookie);
    assert.equal(userByUsername(app.db, "boss")?.role, "admin");

    app.settings.set("auth.oidc.adminEmails", ["ann@example.test"], "test");
    await oidcSignIn(app, issuer, { sub: "m", preferred_username: "ann", email: "ann@example.test" });
    assert.equal(userByUsername(app.db, "ann")?.role, "admin", "promoted at the next sign-in");
  } finally {
    await app.close();
  }
});

let app: Booted;
let cookie: string;
beforeEach(async () => {
  app = await boot();
  await app.makeUser("root", "root password!!", { role: "admin" });
  cookie = (await app.login("root", "root password!!")).cookie;
});
afterEach(() => app.close());

const preset = (body: Record<string, unknown>, as = cookie) => app.send("POST", "/api/admin/oidc/public", body, as);

test("a Google preset with an empty allow list is refused and changes nothing", async () => {
  const res = await preset({ provider: "google", clientId: "id", clientSecret: "secret", allowedEmails: [] });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /at least one allowed address/);
  assert.equal(app.settings.string("auth.oidc.issuer"), "");
  assert.equal(app.settings.bool("auth.oidc.enabled"), false);
});

test("a malformed allow-list entry is refused", async () => {
  const res = await preset({ provider: "google", clientId: "id", clientSecret: "s", allowedEmails: ["not an email"] });
  assert.equal(res.status, 400);
});

test("only admins may set a preset", async () => {
  await app.makeUser("pat", "pat password!!!");
  const member = (await app.login("pat", "pat password!!!")).cookie;
  const res = await preset(
    { provider: "google", clientId: "id", clientSecret: "s", allowedEmails: ["@x.test"] },
    member
  );
  assert.equal(res.status, 403);
});

test("the Microsoft preset points sign-in at the common endpoint with the allow list", async () => {
  app.settings.set("auth.oidc.allowedGroups", ["staff"], "test");
  const res = await preset({
    provider: "microsoft",
    clientId: "ms-app",
    clientSecret: "ms-secret",
    allowedEmails: ["Ann@Example.com", "@example.org"],
    adminEmails: ["ann@example.com"],
  });
  assert.equal(res.status, 200);
  const result = (await res.json()) as PublicSignInResult;
  assert.equal(result.issuer, MICROSOFT_COMMON_ISSUER);
  assert.deepEqual(result.discovery, { ok: true });
  assert.equal(result.redirectUri, `${app.url}/auth/oidc/callback`);
  const s = app.settings;
  assert.equal(s.string("auth.oidc.issuer"), MICROSOFT_COMMON_ISSUER);
  assert.equal(s.string("auth.oidc.clientId"), "ms-app");
  assert.equal(s.string("auth.oidc.label"), "Sign in with Microsoft");
  assert.equal(s.bool("auth.oidc.enabled"), true);
  assert.equal(s.bool("auth.oidc.autoProvision"), true);
  assert.deepEqual(s.list("auth.oidc.allowedEmails"), ["ann@example.com", "@example.org"]);
  assert.deepEqual(s.list("auth.oidc.adminEmails"), ["ann@example.com"]);
  assert.deepEqual(s.list("auth.oidc.allowedGroups"), [], "groups mean nothing across tenants");

  // Re-saving the same client keeps the stored secret.
  const again = await preset({ provider: "microsoft", clientId: "ms-app", allowedEmails: ["@example.org"] });
  assert.equal(again.status, 200);
  // A different client needs its own secret.
  const other = await preset({ provider: "google", clientId: "g-app", allowedEmails: ["@example.org"] });
  assert.equal(other.status, 400);
});

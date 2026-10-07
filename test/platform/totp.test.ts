// Two-factor sign-in end to end, through the platform's own cookies.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { hashPassword } from "../../src/platform/auth/passwords.js";
import {
  base32Decode,
  base32Encode,
  createPendingToken,
  hotp,
  otpauthUri,
  totp,
  totpEnabledFor,
  totpStatus,
  useRecoveryCode,
  verifyTotp,
} from "../../src/platform/auth/totp.js";
import { createUser, updateUser, userById } from "../../src/platform/auth/users.js";
import type { Core } from "../../src/platform/core.js";
import { sessionCookieName } from "../../src/product.js";
import { boot, cookieFrom, type Booted } from "./harness.js";

const PASSWORD = "correct horse battery";
let app: Booted;
// The TOTP functions only touch the database and settings.
let core: Core;

beforeEach(async () => {
  app = await boot();
  app.settings.set("auth.totp.enabled", true, "test");
  core = { db: app.db, settings: app.settings } as Core;
});
afterEach(() => app.close());

async function makeUser(username: string, role: "admin" | "user" = "user") {
  return app.makeUser(username, PASSWORD, { role });
}

async function post(route: string, body: unknown, cookie = "") {
  const res = await app.send("POST", route, body, cookie);
  return { res, cookie: cookieFrom(res), body: (await res.json()) as Record<string, unknown> };
}

const login = (username: string, password = PASSWORD) => post("/api/auth/login", { username, password });

// Enrols through the API and returns the secret and recovery codes. The
// confirming code is one step back, so a code generated "now" in the test is
// still a later step and is not refused as a replay.
async function enrol(cookie: string) {
  const begun = await post("/api/auth/totp/enroll", {}, cookie);
  assert.equal(begun.res.status, 200, JSON.stringify(begun.body));
  assert.match(begun.body.otpauthUrl as string, /^otpauth:\/\/totp\//);
  const secret = base32Decode(begun.body.secret as string);
  const confirmed = await post("/api/auth/totp/confirm", { code: totp(secret, Date.now() - 30_000) }, cookie);
  assert.equal(confirmed.res.status, 200, JSON.stringify(confirmed.body));
  return { secret, recoveryCodes: confirmed.body.recoveryCodes as string[] };
}

async function enrolledUser(username: string, role: "admin" | "user" = "user") {
  const user = await makeUser(username, role);
  const { cookie } = await login(username);
  return { user, ...(await enrol(cookie)) };
}

test("RFC 6238 SHA1 vectors", () => {
  const secret = Buffer.from("12345678901234567890");
  assert.equal(totp(secret, 59_000, 8), "94287082");
  assert.equal(totp(secret, 1111111109_000, 8), "07081804");
  assert.equal(totp(secret, 1234567890_000, 8), "89005924");
  assert.equal(totp(secret, 20000000000_000, 8), "65353130");
  assert.equal(totp(secret, 59_000), "287082");
  assert.equal(hotp(secret, 0), "755224");
  assert.deepEqual(base32Decode(base32Encode(secret)), secret);
  assert.equal(base32Encode(Buffer.from("foobar")), "MZXW6YTBOI");
});

test("the otpauth URI names the site and the user", () => {
  assert.equal(
    otpauthUri("JBSWY3DPEHPK3PXP", "alice", "My Site"),
    "otpauth://totp/My%20Site%3Aalice?secret=JBSWY3DPEHPK3PXP&issuer=My+Site&algorithm=SHA1&digits=6&period=30"
  );
});

test("codes are accepted one step either side, and never twice", async () => {
  const { user, secret } = await enrolledUser("alice");
  const now = Date.now() + 10 * 60_000;
  assert.equal(verifyTotp(core, user.id, totp(secret, now - 60_000), now), false, "two steps back");
  assert.equal(verifyTotp(core, user.id, totp(secret, now - 30_000), now), true, "one step back");
  assert.equal(verifyTotp(core, user.id, totp(secret, now - 30_000), now), false, "replayed");
  assert.equal(verifyTotp(core, user.id, totp(secret, now), now), true, "current");
  assert.equal(verifyTotp(core, user.id, totp(secret, now), now), false, "replayed");
  assert.equal(verifyTotp(core, user.id, totp(secret, now + 30_000), now), true, "one step ahead");
  assert.equal(verifyTotp(core, user.id, totp(secret, now + 90_000), now), false, "too far ahead");
});

test("the stored secret is sealed", async () => {
  const { user, secret } = await enrolledUser("ana");
  const row = app.db.prepare("SELECT totp_secret, recovery_codes FROM users WHERE id = ?").get(user.id) as Record<
    string,
    string
  >;
  assert.match(row.totp_secret!, /^v1\./);
  assert.ok(!row.totp_secret!.includes(base32Encode(secret)));
  assert.equal((JSON.parse(row.recovery_codes!) as string[]).length, 10);
});

test("a recovery code works once", async () => {
  const { user, recoveryCodes } = await enrolledUser("bob");
  assert.equal(recoveryCodes.length, 10);
  assert.match(recoveryCodes[0]!, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(useRecoveryCode(core, user.id, recoveryCodes[0]!.toLowerCase().replace("-", " ")), true);
  assert.equal(useRecoveryCode(core, user.id, recoveryCodes[0]!), false);
  assert.equal(totpStatus(core, user.id).recoveryCodesLeft, 9);
});

test("with two-factor on, a password alone sets no cookie; the code does", async () => {
  const { secret } = await enrolledUser("carol");
  const first = await login("carol");
  assert.equal(first.res.status, 200);
  assert.equal(first.body.totpRequired, true);
  assert.equal(first.cookie, "");
  assert.equal(typeof first.body.pending, "string");
  const verified = await post("/api/auth/totp/verify", { pending: first.body.pending, code: totp(secret) });
  assert.equal(verified.res.status, 200, JSON.stringify(verified.body));
  assert.ok(verified.cookie);
  const me = (await (await app.get("/api/me", verified.cookie)).json()) as Record<string, unknown>;
  assert.equal(me.id, "carol");
  const row = app.db
    .prepare(
      "SELECT detail FROM audit_log WHERE username = 'carol' AND action = 'auth.sign-in' AND result = 'ok' ORDER BY id DESC"
    )
    .get() as { detail: string };
  assert.equal(row.detail, "totp");
});

test("a recovery code, in its own field or the code field, completes sign-in once", async () => {
  const { recoveryCodes } = await enrolledUser("cleo");
  const first = await login("cleo");
  const verified = await post("/api/auth/totp/verify", { pending: first.body.pending, code: recoveryCodes[3] });
  assert.equal(verified.res.status, 200);
  assert.ok(verified.cookie);
  const again = await post("/api/auth/totp/verify", { pending: first.body.pending, code: recoveryCodes[3] });
  assert.equal(again.res.status, 401);
  const own = await post("/api/auth/totp/verify", { pending: first.body.pending, recoveryCode: recoveryCodes[4] });
  assert.equal(own.res.status, 200);
  const row = app.db
    .prepare("SELECT detail FROM audit_log WHERE username = 'cleo' AND result = 'ok' ORDER BY id DESC")
    .get() as { detail: string };
  assert.equal(row.detail, "recovery-code");
});

test("wrong codes are throttled with the password limiter", async () => {
  const { secret } = await enrolledUser("dave");
  const { body } = await login("dave");
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await post("/api/auth/totp/verify", { pending: body.pending, code: "000000" })).res.status, 401);
  }
  const blocked = await post("/api/auth/totp/verify", { pending: body.pending, code: totp(secret) });
  assert.equal(blocked.res.status, 429);
  assert.equal(blocked.cookie, "");
  assert.equal((await login("dave")).res.status, 429);
});

test("an expired, altered or pre-password-change pending token is refused", async () => {
  const { user, secret } = await enrolledUser("erin");
  const account = userById(app.db, user.id)!;
  const expired = createPendingToken(account, Date.now() - 6 * 60_000);
  assert.equal((await post("/api/auth/totp/verify", { pending: expired, code: totp(secret) })).res.status, 401);
  const good = createPendingToken(account);
  const [payload, mac] = good.split(".") as [string, string];
  const forged = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), e: Date.now() + 3_600_000 })
  ).toString("base64url");
  assert.equal(
    (await post("/api/auth/totp/verify", { pending: `${forged}.${mac}`, code: totp(secret) })).res.status,
    401
  );
  const resigned = `${payload}.${crypto.randomBytes(32).toString("base64url")}`;
  assert.equal((await post("/api/auth/totp/verify", { pending: resigned, code: totp(secret) })).res.status, 401);
  updateUser(app.db, user.id, { passwordHash: await hashPassword("another password!") });
  assert.equal((await post("/api/auth/totp/verify", { pending: good, code: totp(secret) })).res.status, 401);
});

test("required two-factor blocks the API until enrolment, then lets the session through", async () => {
  app.settings.set("auth.totp.require", "admins", "test");
  await makeUser("plain");
  const plain = await login("plain");
  assert.equal((await app.get("/api/system/modules", plain.cookie)).status, 200);
  await makeUser("boss", "admin");
  const { cookie } = await login("boss");
  for (const path of ["/api/admin/users", "/api/system/modules"]) {
    const blocked = await app.get(path, cookie);
    assert.equal(blocked.status, 403, path);
    assert.equal(((await blocked.json()) as { mustEnrollTotp?: boolean }).mustEnrollTotp, true);
  }
  const me = (await (await app.get("/api/me", cookie)).json()) as Record<string, unknown>;
  assert.equal(me.mustEnrollTotp, true);
  await enrol(cookie);
  assert.equal((await app.get("/api/admin/users", cookie)).status, 200);
  assert.equal((await post("/api/auth/totp/disable", { password: PASSWORD }, cookie)).res.status, 409);
});

test("turning two-factor off needs the password", async () => {
  const user = await makeUser("fay");
  const { cookie } = await login("fay");
  await enrol(cookie);
  assert.equal((await post("/api/auth/totp/disable", { password: "wrong password" }, cookie)).res.status, 400);
  assert.equal(totpEnabledFor(core, user.id), true);
  assert.equal((await post("/api/auth/totp/disable", { password: PASSWORD }, cookie)).res.status, 200);
  assert.equal(totpEnabledFor(core, user.id), false);
  assert.ok(app.db.prepare("SELECT 1 FROM audit_log WHERE action = 'auth.totp-disable' AND result = 'ok'").get());
});

test("status reports enrolment, availability and policy", async () => {
  await makeUser("gail");
  const { cookie } = await login("gail");
  const before = (await (await app.get("/api/auth/totp/status", cookie)).json()) as Record<string, unknown>;
  assert.deepEqual(before, { enabled: false, available: true, required: false, recoveryCodesLeft: 0 });
  await enrol(cookie);
  const after = (await (await app.get("/api/auth/totp/status", cookie)).json()) as Record<string, unknown>;
  assert.deepEqual(after, { enabled: true, available: true, required: false, recoveryCodesLeft: 10 });
});

test("new recovery codes need a current code and replace the old ones", async () => {
  const user = await makeUser("gus");
  const { cookie } = await login("gus");
  const { secret, recoveryCodes } = await enrol(cookie);
  assert.equal((await post("/api/auth/totp/recovery-codes", { code: "123456" }, cookie)).res.status, 400);
  const fresh = await post("/api/auth/totp/recovery-codes", { code: totp(secret) }, cookie);
  assert.equal(fresh.res.status, 200);
  assert.equal((fresh.body.recoveryCodes as string[]).length, 10);
  assert.equal(useRecoveryCode(core, user.id, recoveryCodes[0]!), false);
  assert.equal(useRecoveryCode(core, user.id, (fresh.body.recoveryCodes as string[])[0]!), true);
});

test("enrolment refuses while the feature is off or SECRETS_KEY is missing", async () => {
  await makeUser("hana");
  const { cookie } = await login("hana");
  app.settings.set("auth.totp.enabled", false, "test");
  assert.equal((await post("/api/auth/totp/enroll", {}, cookie)).res.status, 409);
  app.settings.set("auth.totp.enabled", true, "test");
  const key = process.env.SECRETS_KEY;
  delete process.env.SECRETS_KEY;
  try {
    const refused = await post("/api/auth/totp/enroll", {}, cookie);
    assert.equal(refused.res.status, 409);
    assert.match(refused.body.error as string, /SECRETS_KEY/);
  } finally {
    process.env.SECRETS_KEY = key;
  }
});

test("OIDC sessions are exempt from the policy and from the routes", async () => {
  app.settings.set("auth.totp.require", "all", "test");
  const user = createUser(app.db, { orgId: "default", username: "sso-user", passwordHash: null, role: "user" });
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  app.db
    .prepare(
      `INSERT INTO sessions (id_hash, user_id, method, groups, created_at, last_seen_at, expires_at, ip, user_agent, oidc_checked_at)
       VALUES (?, ?, 'oidc', '[]', ?, ?, ?, '127.0.0.1', '', ?)`
    )
    .run(crypto.createHash("sha256").update(token).digest("hex"), user.id, now, now, now + 3_600_000, now);
  const cookie = `${sessionCookieName}=${token}`;
  assert.equal((await app.get("/api/system/modules", cookie)).status, 200);
  const enroll = await post("/api/auth/totp/enroll", {}, cookie);
  assert.equal(enroll.res.status, 400);
  assert.match(enroll.body.error as string, /identity provider/);
});

test("an admin reset clears the authenticator and the user's sessions", async () => {
  await makeUser("root", "admin");
  const admin = await login("root");
  const { user } = await enrolledUser("ivan");
  const users = (await (await app.get("/api/admin/users", admin.cookie)).json()) as {
    username: string;
    totpEnabled: boolean;
  }[];
  assert.equal(users.find((row) => row.username === "ivan")?.totpEnabled, true);
  assert.equal((await post(`/api/admin/users/${user.id}/totp/reset`, {}, admin.cookie)).res.status, 200);
  assert.equal(totpEnabledFor(core, user.id), false);
  const row = app.db.prepare("SELECT totp_secret, recovery_codes FROM users WHERE id = ?").get(user.id) as Record<
    string,
    unknown
  >;
  assert.equal(row.totp_secret, null);
  assert.equal(row.recovery_codes, "[]");
  const signedIn = await login("ivan");
  assert.equal(signedIn.body.totpRequired, undefined);
  assert.ok(signedIn.cookie);
});

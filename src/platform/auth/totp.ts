import crypto from "node:crypto";
import type { Core } from "../core.js";
import { open, rawSecretKey, seal, secretKeyConfigured } from "../secretBox.js";

// Two-factor codes (RFC 6238) for local accounts: HMAC-SHA1, six digits,
// 30-second steps, one step of clock drift either way.
//
// The sealed column holds {secret, lastStep}: the last time-step a code was
// accepted for. A code is good only for a later step, which is what makes
// one seen over a shoulder or in a proxy log useless. It lives in the row
// rather than in memory because the second of two pods would otherwise
// accept the same code again.

const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1;
const RECOVERY_CODES = 10;
// No 0/O, 1/I/L: these get read off paper and typed back in.
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PENDING_TTL_MS = 5 * 60 * 1000;

export class TotpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

// Lenient about case, spaces and padding, since authenticator apps and
// people copy secrets in every one of those shapes.
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error(`Not a base32 character: ${char}`);
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", secret).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function timeStep(now = Date.now()): number {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

export function totp(secret: Buffer, now = Date.now(), digits = DIGITS): string {
  return hotp(secret, timeStep(now), digits);
}

export function otpauthUri(secret: string, username: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${username}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// The step a code belongs to, if it is within the window and later than
// the last one accepted.
export function matchStep(secret: Buffer, code: string, lastStep: number | null, now = Date.now()): number | null {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const current = timeStep(now);
  let found: number | null = null;
  for (let step = current - WINDOW; step <= current + WINDOW; step += 1) {
    // Every candidate is compared, so timing says nothing about which one
    // matched.
    if (sameText(hotp(secret, step), clean) && (lastStep === null || step > lastStep)) found ??= step;
  }
  return found;
}

interface Blob {
  secret: string;
  lastStep: number | null;
}

interface Row {
  totp_secret: string | null;
  totp_enabled_at: number | null;
  recovery_codes: string;
}

function row(core: Core, userId: number): Row | null {
  return (
    (core.db.prepare("SELECT totp_secret, totp_enabled_at, recovery_codes FROM users WHERE id = ?").get(userId) as
      Row | undefined) ?? null
  );
}

function unseal(sealed: string): Blob {
  const parsed = JSON.parse(open(sealed)) as Partial<Blob>;
  if (typeof parsed.secret !== "string") throw new TotpError(500, "The stored authenticator is unreadable.");
  return { secret: parsed.secret, lastStep: typeof parsed.lastStep === "number" ? parsed.lastStep : null };
}

function requireKey(): void {
  if (!secretKeyConfigured()) {
    throw new TotpError(409, "Two-factor sign-in needs SECRETS_KEY to be set on the server.");
  }
}

function hashRecoveryCode(code: string): string {
  return crypto
    .createHash("sha256")
    .update(code.toUpperCase().replace(/[^A-Z0-9]/g, ""))
    .digest("hex");
}

function newRecoveryCodes(): { plain: string[]; hashes: string[] } {
  const plain = Array.from({ length: RECOVERY_CODES }, () => {
    const chars = Array.from({ length: 8 }, () => RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)]);
    return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
  });
  return { plain, hashes: plain.map(hashRecoveryCode) };
}

function recoveryHashes(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export function totpEnabledFor(core: Core, userId: number): boolean {
  const found = core.db.prepare("SELECT totp_enabled_at FROM users WHERE id = ?").get(userId) as
    { totp_enabled_at: number | null } | undefined;
  return found?.totp_enabled_at != null;
}

// Whether policy obliges this account to have an authenticator. Only
// password sign-ins are in scope; the caller checks the method.
export function totpRequiredFor(admin: boolean, policy: string): boolean {
  if (policy === "all") return true;
  if (policy === "admins") return admin;
  return false;
}

export interface TotpStatus {
  enabled: boolean;
  enabledAt: number | null;
  recoveryCodesLeft: number;
}

export function totpStatus(core: Core, userId: number): TotpStatus {
  const current = row(core, userId);
  return {
    enabled: current?.totp_enabled_at != null,
    enabledAt: current?.totp_enabled_at ?? null,
    recoveryCodesLeft: current?.totp_enabled_at != null ? recoveryHashes(current.recovery_codes).length : 0,
  };
}

// Stores a fresh secret, not yet enabled; a second call replaces it, so an
// abandoned enrolment leaves nothing behind that works.
export function beginEnrollment(core: Core, userId: number, username: string): { secret: string; otpauthUrl: string } {
  requireKey();
  if (totpEnabledFor(core, userId))
    throw new TotpError(409, "Two-factor is already on. Turn it off first to set up a new authenticator.");
  const secret = generateSecret();
  core.db
    .prepare("UPDATE users SET totp_secret = ?, totp_enabled_at = NULL, recovery_codes = '[]' WHERE id = ?")
    .run(seal(JSON.stringify({ secret, lastStep: null } satisfies Blob)), userId);
  return { secret, otpauthUrl: otpauthUri(secret, username, core.settings.string("site.name")) };
}

// Writes the new blob only if the stored one is still the one read, so two
// pods checking the same code at once cannot both accept it.
function swapBlob(
  core: Core,
  userId: number,
  before: string,
  blob: Blob,
  extra: { enabledAt?: number; recoveryCodes?: string[] } = {}
): boolean {
  const sets = ["totp_secret = ?"];
  const values: unknown[] = [seal(JSON.stringify(blob))];
  if (extra.enabledAt !== undefined) {
    sets.push("totp_enabled_at = ?");
    values.push(extra.enabledAt);
  }
  if (extra.recoveryCodes !== undefined) {
    sets.push("recovery_codes = ?");
    values.push(JSON.stringify(extra.recoveryCodes));
  }
  return (
    core.db
      .prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ? AND totp_secret = ?`)
      .run(...values, userId, before).changes === 1
  );
}

export function confirmEnrollment(core: Core, userId: number, code: string, now = Date.now()): string[] {
  requireKey();
  const current = row(core, userId);
  if (current?.totp_enabled_at != null) throw new TotpError(409, "Two-factor is already on.");
  if (!current?.totp_secret) throw new TotpError(409, "Start setting up an authenticator first.");
  const blob = unseal(current.totp_secret);
  const step = matchStep(base32Decode(blob.secret), code, blob.lastStep, now);
  if (step === null) throw new TotpError(400, "That code is not right. Check the time on your device and try again.");
  const codes = newRecoveryCodes();
  if (
    !swapBlob(
      core,
      userId,
      current.totp_secret,
      { ...blob, lastStep: step },
      { enabledAt: now, recoveryCodes: codes.hashes }
    )
  ) {
    throw new TotpError(409, "Setup changed while confirming. Start again.");
  }
  return codes.plain;
}

// True once per accepted code. A SecretKeyError from a changed key
// propagates: that is an operator problem, not a wrong code.
export function verifyTotp(core: Core, userId: number, code: string, now = Date.now()): boolean {
  const current = row(core, userId);
  if (current?.totp_enabled_at == null || !current.totp_secret) return false;
  const blob = unseal(current.totp_secret);
  const step = matchStep(base32Decode(blob.secret), code, blob.lastStep, now);
  if (step === null) return false;
  return swapBlob(core, userId, current.totp_secret, { ...blob, lastStep: step });
}

export function useRecoveryCode(core: Core, userId: number, code: string): boolean {
  const current = row(core, userId);
  if (current?.totp_enabled_at == null) return false;
  const hashes = recoveryHashes(current.recovery_codes);
  const wanted = hashRecoveryCode(code);
  const index = hashes.findIndex((hash) => sameText(hash, wanted));
  if (index === -1) return false;
  const rest = hashes.filter((_, i) => i !== index);
  return (
    core.db
      .prepare("UPDATE users SET recovery_codes = ? WHERE id = ? AND recovery_codes = ?")
      .run(JSON.stringify(rest), userId, current.recovery_codes).changes === 1
  );
}

export function regenerateRecoveryCodes(core: Core, userId: number): string[] {
  if (!totpEnabledFor(core, userId)) throw new TotpError(409, "Two-factor is not on.");
  const codes = newRecoveryCodes();
  core.db.prepare("UPDATE users SET recovery_codes = ? WHERE id = ?").run(JSON.stringify(codes.hashes), userId);
  return codes.plain;
}

// Removes a user's authenticator and recovery codes. Used by turning it
// off, the admin "reset two-factor" action and the break-glass CLI. The
// sealed column goes whole, so no shape of it survives.
export function clearTotp(core: Core, userId: number): void {
  core.db
    .prepare("UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, recovery_codes = '[]' WHERE id = ?")
    .run(userId);
}

// The token between a right password and a right code. Stateless and
// signed, so the code can be checked by either pod without a table. It is
// bound to the password hash, so changing the password (or reset-admin)
// voids any token already handed out.
let pendingKey: { raw: string; key: Buffer } | null = null;

function pendingSigningKey(): Buffer {
  requireKey();
  const raw = rawSecretKey();
  if (pendingKey?.raw !== raw) {
    pendingKey = { raw, key: Buffer.from(crypto.hkdfSync("sha256", raw, "platform", "totp-pending/v1", 32)) };
  }
  return pendingKey.key;
}

function passwordBinding(passwordHash: string | null): string {
  return crypto
    .createHash("sha256")
    .update(passwordHash ?? "")
    .digest("base64url")
    .slice(0, 16);
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", pendingSigningKey()).update(payload).digest("base64url");
}

export function createPendingToken(account: { id: number; passwordHash: string | null }, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ u: account.id, e: now + PENDING_TTL_MS, p: passwordBinding(account.passwordHash) })
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

// The user id the token was issued for, or null for anything expired,
// altered or issued before a password change.
export function readPendingToken(
  token: string,
  lookup: (id: number) => { passwordHash: string | null } | null,
  now = Date.now()
): number | null {
  const [payload, mac] = token.split(".");
  if (!payload || !mac || !sameText(sign(payload), mac)) return null;
  let parsed: { u?: unknown; e?: unknown; p?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof parsed;
  } catch {
    return null;
  }
  if (typeof parsed.u !== "number" || typeof parsed.e !== "number" || typeof parsed.p !== "string") return null;
  if (parsed.e <= now) return null;
  const account = lookup(parsed.u);
  if (account === null || !sameText(passwordBinding(account.passwordHash), parsed.p)) return null;
  return parsed.u;
}

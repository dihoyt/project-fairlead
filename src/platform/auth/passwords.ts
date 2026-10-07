import crypto from "node:crypto";
import { promisify } from "node:util";

// scrypt from node:crypto rather than a native argon2 module: it needs no
// build step on any platform someone installs this on, and at these
// parameters (32 MiB, the interactive-login setting from the scrypt paper)
// it is a sound password hash. The parameters are stored with each hash,
// so raising them later only affects passwords set after the change.

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions
) => Promise<Buffer>;

const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
// scrypt needs 128 * N * r bytes; Node's default cap is exactly that, so
// the headroom keeps a future increase from failing at sign-in.
const MAXMEM = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 10;

function encode(salt: Buffer, hash: Buffer): string {
  return ["scrypt", N, R, P, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  return encode(salt, await scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAXMEM }));
}

// For first-boot setup, which runs before the server accepts a request.
export function hashPasswordSync(password: string): string {
  const salt = crypto.randomBytes(16);
  return encode(salt, crypto.scryptSync(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAXMEM }));
}

let dummy: Promise<string> | null = null;

// With no hash (unknown user, or an account that has no password) the
// same work is still done against a throwaway hash, so response time says
// nothing about which usernames exist.
export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  if (!stored) {
    dummy ??= hashPassword("not-a-real-password");
    await verifyPassword(await dummy, password);
    return false;
  }
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 1024) return "That password is too long.";
  return null;
}

// Readable enough to read out or paste once, e.g. "maple-river-4821-orbit".
export function generateTempPassword(): string {
  const words = [
    "maple",
    "river",
    "orbit",
    "ember",
    "cedar",
    "comet",
    "delta",
    "falcon",
    "harbor",
    "lunar",
    "otter",
    "pixel",
    "quartz",
    "raven",
    "summit",
    "tundra",
  ];
  const pick = () => words[crypto.randomInt(words.length)];
  return `${pick()}-${pick()}-${crypto.randomInt(1000, 10000)}-${pick()}`;
}

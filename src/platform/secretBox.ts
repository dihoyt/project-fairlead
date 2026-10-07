import crypto from "node:crypto";

// Secrets are stored encrypted so that the database file alone (a backup, a
// copied volume, a support bundle) is not a set of live credentials. The key
// lives only in the process environment (SECRETS_KEY, from a Kubernetes
// Secret), never beside the data.
//
// AES-256-GCM, with the key stretched from whatever string the operator
// supplied. scrypt rather than a bare hash because SECRETS_KEY is a
// human-handled value, and its salt is fixed because the derived key has to
// be the same on every pod and every restart.

const KEY_VAR = "SECRETS_KEY";
const MIN_KEY_LENGTH = 16;
const FORMAT = "v1";

export class SecretKeyError extends Error {}

let cached: { raw: string; key: Buffer } | null = null;

export function rawSecretKey(): string {
  return (process.env[KEY_VAR] ?? "").trim();
}

function key(): Buffer {
  const raw = rawSecretKey();
  if (raw === "") throw new SecretKeyError(`${KEY_VAR} is not set, so secrets cannot be stored or read.`);
  if (raw.length < MIN_KEY_LENGTH)
    throw new SecretKeyError(`${KEY_VAR} must be at least ${MIN_KEY_LENGTH} characters.`);
  if (cached?.raw !== raw) {
    cached = { raw, key: crypto.scryptSync(raw, "platform/secrets/v1", 32) };
  }
  return cached.key;
}

export function secretKeyConfigured(): boolean {
  return rawSecretKey().length >= MIN_KEY_LENGTH;
}

export function seal(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [FORMAT, iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

// Throws on a wrong key rather than returning garbage: GCM's tag check is
// what tells "SECRETS_KEY was rotated" apart from an odd-looking value, and
// the caller has to be able to say which.
export function open(sealed: string): string {
  const [format, iv, tag, body] = sealed.split(".");
  if (format !== FORMAT || !iv || !tag || body === undefined) {
    throw new SecretKeyError("Stored secret is not in a known format.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretKeyError(`A stored secret could not be decrypted; ${KEY_VAR} has changed since it was saved.`);
  }
}

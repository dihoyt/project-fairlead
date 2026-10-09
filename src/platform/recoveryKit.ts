import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { product } from "../product.js";

// The format `openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -a -A`
// reads: "Salted__", an 8-byte salt, then the ciphertext under a key and IV
// derived together from the passphrase. install.sh opens it with nothing but
// openssl, and so can a person by hand.
export const KIT_ITERATIONS = 600_000;
export const MIN_PASSPHRASE = 12;

export interface KitFields {
  secretsKey: string;
  release: string;
  namespace: string;
  version: string;
  createdAt: string;
}

export function sealKit(fields: KitFields, passphrase: string): string {
  const salt = randomBytes(8);
  const derived = pbkdf2Sync(passphrase, salt, KIT_ITERATIONS, 48, "sha256");
  const cipher = createCipheriv("aes-256-cbc", derived.subarray(0, 32), derived.subarray(32));
  const body = [
    `SECRETS_KEY=${fields.secretsKey}`,
    `RELEASE=${fields.release}`,
    `NAMESPACE=${fields.namespace}`,
    `VERSION=${fields.version}`,
    `CREATED_AT=${fields.createdAt}`,
    "KIT_VERSION=1",
    "",
  ].join("\n");
  const sealed = Buffer.concat([Buffer.from("Salted__"), salt, cipher.update(body), cipher.final()]);
  return [
    `# ${product.displayName} recovery kit`,
    `# release: ${fields.release}  namespace: ${fields.namespace}  build: ${fields.version}  created: ${fields.createdAt}`,
    "# Holds the key that opens this install's stored secrets, sealed with the passphrase chosen when it was made.",
    `# Open with: grep -v '^#' <this file> | openssl enc -d -aes-256-cbc -pbkdf2 -iter ${KIT_ITERATIONS} -md sha256 -a -A`,
    sealed.toString("base64"),
    "",
  ].join("\n");
}

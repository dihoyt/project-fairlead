import { MASK } from "./plan.js";

// Shorter values would mask ordinary words all over a log.
const MIN_SECRET_LENGTH = 4;
// One runaway line must not become the whole response.
export const MAX_LINE = 16 * 1024;

export type Redactor = (line: string) => { line: string; redacted: boolean };

// Replaces each secret value, plain or base64-encoded, longest first so a
// value containing another is masked whole.
export function createRedactor(secrets: readonly string[]): Redactor {
  const needles = new Set<string>();
  for (const value of secrets) {
    if (value.length < MIN_SECRET_LENGTH) continue;
    needles.add(value);
    const b64 = Buffer.from(value).toString("base64");
    needles.add(b64);
    needles.add(b64.replace(/=+$/, ""));
  }
  const ordered = [...needles].toSorted((a, b) => b.length - a.length);
  return (raw) => {
    let line = raw;
    let redacted = false;
    for (const needle of ordered) {
      if (line.includes(needle)) {
        line = line.split(needle).join(MASK);
        redacted = true;
      }
    }
    // Cut after masking, so a cut never leaves part of a secret behind.
    if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)} …[line cut at ${MAX_LINE} characters]`;
    return { line, redacted };
  };
}

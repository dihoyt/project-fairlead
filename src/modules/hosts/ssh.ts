import { createHash } from "node:crypto";
import ssh2 from "ssh2";

const { Client, utils } = ssh2;

export interface SshTarget {
  address: string;
  port: number;
  username: string;
  auth: "key" | "password";
  credential: string;
  // "SHA256:…"; when set, a host presenting any other key is refused.
  pin?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  // null when the command was killed by a signal or timed out.
  code: number | null;
  timedOut?: boolean;
}

export interface SshSession {
  fingerprint: string;
  exec(command: string, timeoutMs: number): Promise<ExecResult>;
  close(): void;
}

export class HostKeyMismatch extends Error {
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(`Host key changed: pinned ${expected}, host presented ${actual}.`);
    this.expected = expected;
    this.actual = actual;
  }
}

// Caps what one command can make us buffer; the outputs we parse are small.
const MAX_OUTPUT = 1024 * 1024;

export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

// Why a stored credential cannot be used, or null when it can.
export function credentialProblem(auth: "key" | "password", credential: string): string | null {
  if (auth === "password") return credential.length > 0 ? null : "The password is empty.";
  const parsed = utils.parseKey(credential);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) {
    const message = key instanceof Error ? key.message : "unreadable";
    return /encrypted/i.test(message)
      ? "The private key is passphrase-protected; use an unencrypted key dedicated to monitoring."
      : `The private key could not be read: ${message}`;
  }
  if (!key.isPrivateKey()) return "That is a public key; paste the private key.";
  return null;
}

export function connect(target: SshTarget, options: { timeoutMs: number; signal?: AbortSignal }): Promise<SshSession> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let fingerprint = "";
    let mismatch: HostKeyMismatch | undefined;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      client.end();
      reject(err);
    };
    const onAbort = () => fail(new Error("Collection was cancelled."));
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    client.on("error", (err) => fail(mismatch ?? err));
    client.on("close", () => fail(mismatch ?? new Error("Connection closed before it was ready.")));
    client.on("ready", () => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      const session: SshSession = {
        fingerprint,
        exec: (command, timeoutMs) => exec(client, command, timeoutMs),
        close: () => client.end(),
      };
      options.signal?.addEventListener("abort", () => client.end(), { once: true });
      resolve(session);
    });

    try {
      client.connect({
        host: target.address,
        port: target.port,
        username: target.username,
        ...(target.auth === "key" ? { privateKey: target.credential } : { password: target.credential }),
        tryKeyboard: false,
        agent: undefined,
        readyTimeout: options.timeoutMs,
        hostVerifier: (key: Buffer) => {
          fingerprint = fingerprintOf(key);
          if (target.pin && target.pin !== fingerprint) {
            mismatch = new HostKeyMismatch(target.pin, fingerprint);
            return false;
          }
          return true;
        },
      });
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function exec(client: import("ssh2").Client, command: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const out: ExecResult = { stdout: "", stderr: "", code: null };
    let channel: import("ssh2").ClientChannel | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(out);
    };
    // A timed-out command's channel is closed so it cannot hold a session slot.
    const timer = setTimeout(() => {
      out.timedOut = true;
      channel?.close();
      finish();
    }, timeoutMs);
    client.exec(command, (err, stream) => {
      if (err) {
        out.stderr = err.message;
        return finish();
      }
      channel = stream;
      if (done) return void stream.close();
      stream.on("data", (chunk: Buffer) => {
        if (out.stdout.length < MAX_OUTPUT) out.stdout += chunk.toString("utf8");
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        if (out.stderr.length < MAX_OUTPUT) out.stderr += chunk.toString("utf8");
      });
      stream.on("exit", (code: number | null) => {
        out.code = code;
      });
      stream.on("close", finish);
      stream.on("error", finish);
    });
  });
}

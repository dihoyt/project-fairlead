import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";

// An SSH server that answers exec requests from a table of canned results,
// for host collectors that run fixed command lines. It records what it was
// asked, answers anything not in the table with exit 127 so an unexpected
// command shows up in `unexpected` rather than passing silently, and never
// opens a shell, sftp or port forward.

const { Server, utils } = ssh2;

export interface CannedResult {
  stdout?: string;
  stderr?: string;
  code?: number;
  // Delay before answering, for timeout tests.
  delayMs?: number;
}

export type CommandTable =
  Record<string, CannedResult | string> | ((command: string) => CannedResult | string | undefined);

export interface FakeSshOptions {
  username?: string;
  // Exactly one of the two credentials is accepted.
  password?: string;
  // Public key (OpenSSH format) accepted for the user.
  publicKey?: string;
  commands: CommandTable;
  // Reuse a host key across restarts to test pinning; generated otherwise.
  hostKey?: string;
}

export interface FakeSshHost {
  host: string;
  port: number;
  username: string;
  // "SHA256:<base64>" as OpenSSH prints it.
  fingerprint: string;
  hostKey: string;
  // Every exec command received, in order.
  executed: string[];
  // The subset not found in the command table.
  unexpected: string[];
  // Authentication attempts as "<method> <ok|fail>".
  auth: string[];
  close(): Promise<void>;
}

// ssh2's ed25519 generator now and then emits an OpenSSH key that its own
// parser rejects (about 1 in 300), so keys are checked and regenerated.
export function generateKeyPair(): { privateKey: string; publicKey: string } {
  for (;;) {
    const { private: privateKey, public: publicKey } = utils.generateKeyPairSync("ed25519");
    if (!(utils.parseKey(privateKey) instanceof Error) && !(utils.parseKey(publicKey) instanceof Error)) {
      return { privateKey, publicKey };
    }
  }
}

export async function startFakeSshHost(options: FakeSshOptions): Promise<FakeSshHost> {
  const username = options.username ?? "monitor";
  const hostKey = options.hostKey ?? generateKeyPair().privateKey;
  const accepted = options.publicKey ? utils.parseKey(options.publicKey) : undefined;
  const acceptedKey = Array.isArray(accepted) ? accepted[0] : accepted;
  if (acceptedKey instanceof Error) throw acceptedKey;

  const executed: string[] = [];
  const unexpected: string[] = [];
  const auth: string[] = [];
  const clients = new Set<import("ssh2").Connection>();

  const lookup = (command: string): CannedResult | undefined => {
    const found = typeof options.commands === "function" ? options.commands(command) : options.commands[command];
    return typeof found === "string" ? { stdout: found } : found;
  };

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      const ok =
        ctx.username === username &&
        ((ctx.method === "password" && options.password !== undefined && ctx.password === options.password) ||
          (ctx.method === "publickey" &&
            acceptedKey !== undefined &&
            ctx.key.algo === acceptedKey.type &&
            Buffer.compare(ctx.key.data, acceptedKey.getPublicSSH()) === 0 &&
            (!ctx.signature || acceptedKey.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true)));
      if (ctx.method !== "none") auth.push(`${ctx.method} ${ok ? "ok" : "fail"}`);
      if (ok) ctx.accept();
      else ctx.reject([options.password !== undefined ? "password" : "publickey"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          executed.push(info.command);
          const result = lookup(info.command);
          if (!result) unexpected.push(info.command);
          const reply = result ?? { stderr: `sh: ${info.command}: command not found\n`, code: 127 };
          setTimeout(() => {
            if (reply.stdout) stream.write(reply.stdout);
            if (reply.stderr) stream.stderr.write(reply.stderr);
            stream.exit(reply.code ?? 0);
            stream.end();
          }, reply.delayMs ?? 0);
        });
        session.on("shell", (_accept, reject) => reject());
        session.on("subsystem", (_accept, reject) => reject());
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const parsed = utils.parseKey(hostKey);
  const pub = Array.isArray(parsed) ? parsed[0]! : parsed;
  if (pub instanceof Error) throw pub;
  const fingerprint = `SHA256:${createHash("sha256").update(pub.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;

  return {
    host: "127.0.0.1",
    port,
    username,
    fingerprint,
    hostKey,
    executed,
    unexpected,
    auth,
    async close() {
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

import ssh2 from "ssh2";
import type { HostKeypair } from "../../contracts/hosts.js";
import type { SecretStore } from "../../contracts/platform.js";
import { product } from "../../product.js";
import { fingerprintOf } from "./ssh.js";

const { utils } = ssh2;

export const KEYPAIR_SCOPE = "hosts:keypair";
const KEYPAIR_ID = "ed25519";

interface StoredKeypair {
  privateKey: string;
  publicKey: string;
  createdAt: string;
}

// The public half as one authorized_keys line: "ssh-ed25519 <base64> <comment>".
// Only base64 and the product slug, so it is safe inside single quotes.
const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]+=* [a-z0-9@._-]+$/;

// "restrict" turns off forwarding, agent and pty for this key: collection
// only ever runs fixed commands on an exec channel. The grep keeps a second
// paste from adding the line twice.
export function installCommand(publicKey: string): string {
  if (!PUBLIC_KEY.test(publicKey)) throw new Error("Refusing to template an unexpected public key.");
  const line = `restrict ${publicKey}`;
  return (
    `umask 077 && mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && ` +
    `(grep -qxF '${line}' ~/.ssh/authorized_keys || echo '${line}' >> ~/.ssh/authorized_keys) && ` +
    `chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`
  );
}

function view(stored: StoredKeypair): HostKeypair {
  const blob = Buffer.from(stored.publicKey.split(" ")[1] ?? "", "base64");
  return {
    publicKey: stored.publicKey,
    fingerprint: fingerprintOf(blob),
    createdAt: stored.createdAt,
    installCommand: installCommand(stored.publicKey),
  };
}

// ssh2's generator now and then emits an ed25519 key its own parser rejects,
// so a pair is only kept once both halves parse.
function generate(): { privateKey: string; publicKey: string } {
  for (let attempt = 0; attempt < 20; attempt++) {
    const pair = utils.generateKeyPairSync("ed25519", { comment: product.slug });
    if (!(utils.parseKey(pair.private) instanceof Error) && !(utils.parseKey(pair.public) instanceof Error)) {
      return { privateKey: pair.private, publicKey: pair.public.trim() };
    }
  }
  throw new Error("Could not generate a usable ed25519 key pair.");
}

export function createKeypairStore(secrets: SecretStore, now: () => number = Date.now) {
  async function read(): Promise<StoredKeypair | null> {
    const raw = await secrets.get(KEYPAIR_SCOPE, KEYPAIR_ID);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredKeypair;
      return parsed.privateKey && parsed.publicKey ? parsed : null;
    } catch {
      return null;
    }
  }

  // Serialises generation within a pod so a double submit cannot write two
  // different pairs and leave hosts installed with the loser.
  let pending: Promise<unknown> = Promise.resolve();

  return {
    async get(): Promise<HostKeypair | null> {
      const stored = await read();
      return stored ? view(stored) : null;
    },

    async privateKey(): Promise<string | null> {
      return (await read())?.privateKey ?? null;
    },

    async exists(): Promise<boolean> {
      return secrets.has(KEYPAIR_SCOPE, KEYPAIR_ID);
    },

    // Resolves to null when a pair exists and rotate is false.
    generate(rotate: boolean): Promise<HostKeypair | null> {
      const run = pending.then(async () => {
        if (!rotate && (await read())) return null;
        const pair = generate();
        const stored: StoredKeypair = { ...pair, createdAt: new Date(now()).toISOString() };
        await secrets.put(KEYPAIR_SCOPE, KEYPAIR_ID, JSON.stringify(stored));
        return view(stored);
      });
      pending = run.catch(() => undefined);
      return run;
    },
  };
}

export type KeypairStore = ReturnType<typeof createKeypairStore>;

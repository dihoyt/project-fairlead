import type { CheckResult, Status } from "./health.js";

export type HostKind = "auto" | "linux" | "synology" | "truenas";

export interface HostView {
  id: string;
  label: string;
  address: string;
  port: number;
  username: string;
  auth: "key" | "password";
  kind: HostKind;
  // What auto-detection found, once the host has been reached.
  detectedKind?: Exclude<HostKind, "auto">;
  hasCredential: boolean;
  // Signs in with the install's generated key pair (GET /api/hosts/keypair)
  // rather than a key of its own. Absent reads as false.
  generatedKey?: boolean;
  // Paths on this host that hold backup targets, for target free space.
  backupTargetPaths: string[];
  status: Status;
  lastSeenAt?: string;
  lastError?: string;
  facts?: {
    hostname?: string;
    os?: string;
    kernel?: string;
    uptimeSeconds?: number;
    cpus?: number;
    memoryBytes?: number;
  };
}

export interface HostRequest {
  label: string;
  address: string;
  port?: number;
  username: string;
  auth: "key" | "password";
  kind?: HostKind;
  backupTargetPaths?: string[];
  // Write-only: private key (PEM/OpenSSH) or password. Omitted on update: keep.
  credential?: string;
  // auth "key" only: use the install's generated key pair; credential is
  // then ignored and any stored one removed.
  useGeneratedKey?: boolean;
  // Pinned on first successful connect; a mismatch afterwards refuses to collect.
  hostKeyFingerprint?: string;
}

export interface HostTestResult {
  ok: boolean;
  hostKeyFingerprint?: string;
  detectedKind?: Exclude<HostKind, "auto">;
  results: CheckResult[];
  error?: string;
}

// One ed25519 key pair per install, generated in the app so a first-timer
// never handles a private key. The private half lives in ctx.secrets
// (scope "hosts:keypair") and is never returned.
export interface HostKeypair {
  // OpenSSH format, with a comment naming this product.
  publicKey: string;
  fingerprint: string;
  createdAt: string;
  // Paste on each host as the user that will sign in: appends publicKey to
  // ~/.ssh/authorized_keys with the right permissions. A fixed template.
  installCommand: string;
}

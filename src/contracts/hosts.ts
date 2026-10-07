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

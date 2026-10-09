// The install seed (../onboarding.ts): an env file's worth of values, the
// Secret install.sh makes from it, and the summary in each state. Pure data,
// so the client can import it.
import type { KubeObject } from "../k8s.js";
import {
  INSTALL_SEED_SECRET,
  SEED_ITEM_LABELS,
  type InstallSeed,
  type InstallSeedKey,
  type InstallSeedView,
  type SeedItemId,
  type SeedItemResult,
} from "../onboarding.js";
import { isoAgo } from "./time.js";

const MINUTE = 60_000;

// What an env file sets, as install.sh stores it. Placeholder values only.
export const mockSeedEnv: Partial<Record<InstallSeedKey, string>> = {
  ADMIN_PASSWORD: "correct-horse-battery",
  PUBLIC_URL: "https://console.example.com",
  CLOUDFLARE_API_TOKEN: "cf-token-example",
  CLOUDFLARE_ZONE: "example.com",
  CLOUDFLARE_ACCESS_APPS: "per-app",
  STORAGE_URL: "cifs://nas.example.com/backups",
  STORAGE_USER: "backup",
  STORAGE_SECRET: "smb-password-example",
  SMTP_PRESET: "gmail",
  SMTP_USER: "alerts@example.com",
  SMTP_PASSWORD: "app-password-example",
  SMTP_FROM: "alerts@example.com",
  SMTP_TO: "ops@example.com, oncall@example.com",
  BUNDLE: "longhorn",
  ADMIN_EMAIL: "admin@example.com",
  AUTHENTIK_BOOTSTRAP_PASSWORD: "authentik-first-password",
};

// mockSeedEnv parsed.
export const mockInstallSeed: InstallSeed = {
  version: 1,
  adminPassword: "correct-horse-battery",
  publicUrl: "https://console.example.com",
  cloudflare: { token: "cf-token-example", zone: "example.com", accessApps: "per-app" },
  storageTarget: {
    protocol: "smb",
    url: "cifs://nas.example.com/backups",
    user: "backup",
    secret: "smb-password-example",
  },
  smtp: {
    preset: "gmail",
    user: "alerts@example.com",
    password: "app-password-example",
    from: "alerts@example.com",
    to: ["ops@example.com", "oncall@example.com"],
  },
  authentikBootstrapPassword: "authentik-first-password",
  bundle: { include: ["longhorn"], adminEmail: "admin@example.com" },
};

// The Secret as the API server returns it, for createFakeK8s's objects.
export function mockSeedSecret(
  namespace: string,
  env: Partial<Record<InstallSeedKey, string>> = mockSeedEnv
): KubeObject {
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    data[key] = btoa(String.fromCharCode(...new TextEncoder().encode(value)));
  }
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: INSTALL_SEED_SECRET.name,
      namespace,
      labels: { "app.kubernetes.io/managed-by": "example" },
    },
    type: "Opaque",
    data,
  };
}

const item = (id: SeedItemId, state: SeedItemResult["state"], detail: string, at?: string): SeedItemResult => ({
  id,
  label: SEED_ITEM_LABELS[id],
  state,
  detail,
  ...(at ? { at } : {}),
});

const imported = isoAgo(20 * MINUTE);
const applied = isoAgo(5 * MINUTE);

// Right after boot: the boot items ran, the rest wait for the first admin.
export const mockSeedPending: InstallSeedView = {
  state: "pending",
  importedAt: imported,
  items: [
    item(
      "admin-password",
      "applied",
      "Set the admin password from the file; no change is asked at first sign-in.",
      imported
    ),
    item("public-url", "applied", "Public URL set to https://console.example.com.", imported),
    item("cloudflare", "pending", "Waiting for the first admin to sign in."),
    item("storage-target", "pending", "Waiting for the first admin to sign in."),
    item("email", "pending", "Waiting for the first admin to sign in."),
    item("bundle", "pending", "Waiting for the first admin to sign in."),
  ],
  dismissed: false,
};

// After /apply, with one failure.
export const mockSeedDone: InstallSeedView = {
  state: "done",
  importedAt: imported,
  appliedAt: applied,
  appliedBy: "admin",
  items: [
    mockSeedPending.items[0]!,
    mockSeedPending.items[1]!,
    item("cloudflare", "applied", "Created the Cloudflare connector for example.com and started its tunnel.", applied),
    item("storage-target", "failed", "nas.example.com:445: connection refused.", applied),
    item("email", "applied", "Created the email channel to ops@example.com, oncall@example.com.", applied),
    item("bundle", "applied", "Started the Deploy bundle with longhorn ticked.", applied),
  ],
  dismissed: false,
};

export const mockSeedNone: InstallSeedView = { state: "none", items: [], dismissed: false };

import type { CloudflareAccessPolicy, StorageProtocol } from "./connectors.js";
import type { EmailPreset, SmtpSecurity } from "./notify.js";

export type OnboardingStepId =
  "password" | "cluster" | "access" | "oidc" | "links" | "hosts" | "checks" | "notifications" | "findings";

export interface OnboardingStep {
  id: OnboardingStepId;
  done: boolean;
  skipped: boolean;
  optional: boolean;
}

export interface OnboardingState {
  complete: boolean;
  steps: OnboardingStep[];
  findings: { unprotectedPvcs: number; unhealthyNodes: number; failingBackups: number };
}

// --- Install seed -----------------------------------------------------------
//
// Unattended set-up from an env file. `install.sh --env <file>` (or the file
// at /etc/<slug>/install.env) accepts only the keys in INSTALL_SEED_KEYS,
// refusing any other by name without echoing a value, and stores them as
// the Secret INSTALL_SEED_SECRET in the product's namespace, one data key per
// env key, before the chart is installed; then it shreds the file unless
// --keep-env. The chart lets the product's ServiceAccount get and delete that
// one Secret by name and no other.
//
// Module "onboarding" reads it once at boot: it seals the values in its own
// secret store (scope "onboarding:seed"), gives the built-in admin
// ADMIN_PASSWORD with no change forced at first sign-in and sets the public
// URL and generic OIDC sign-in (services "signin"), then deletes the Secret.
// The items that go through other modules' routes (Cloudflare, Entra, the
// storage target, the email channel, the bundle) are applied by
// POST /api/onboarding/seed/apply as the first admin who signs in, through
// ModuleContext.call, so they pass the same validation, permission checks and
// audit as the forms; the welcome page calls it on its own and shows the
// result. A value from the file never appears in a log, an audit entry or a
// response, and once every item has run the sealed copy is deleted.
//
// Server-free on purpose: the client imports this file.

export const INSTALL_SEED_SECRET = { name: "install-seed" } as const;

// The env-file keys, no product prefix (rule 4). install.sh carries the same
// list; a test compares them. Values are plain strings; lists are comma
// separated.
export const INSTALL_SEED_KEYS = [
  // The built-in admin's password, at least 10 characters.
  "ADMIN_PASSWORD",
  // site.publicUrl, e.g. https://console.example.com.
  "PUBLIC_URL",
  // Cloudflare connector. ACCOUNT_ID may be left out when the token sees
  // one account. ACCESS_APPS: never, always or per-app.
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE",
  "CLOUDFLARE_ACCESS_APPS",
  // Entra connector (the management app), then sign-in through the app
  // registration it creates. ADMIN_GROUPS: group object ids.
  "ENTRA_TENANT_ID",
  "ENTRA_CLIENT_ID",
  "ENTRA_CLIENT_SECRET",
  "ENTRA_ADMIN_GROUPS",
  // Storage target connector. The protocol follows the URL's scheme:
  // nfs://server:/export, s3://bucket@region/, cifs://server/share.
  // USER and SECRET: the S3 access key pair, or the SMB username and password.
  "STORAGE_URL",
  "STORAGE_PATH",
  "STORAGE_ENDPOINT",
  "STORAGE_USER",
  "STORAGE_SECRET",
  // Email notification channel. PRESET: an SMTP preset (gmail, yahoo,
  // icloud, fastmail, sendgrid, mailgun, ses, smtp) or entra. TO: addresses.
  "SMTP_PRESET",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURITY",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_FROM",
  "SMTP_TO",
  // Generic OIDC sign-in.
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_LABEL",
  "OIDC_ADMIN_GROUPS",
  // The deploy bundle (needs install.sh --enable-deploy). BUNDLE: "default"
  // for the bundle's own ticks, or the optional items to tick by app id
  // ("longhorn"); required items always install. ACCESS: cloudflare-tunnel
  // (through the Cloudflare connector), local or direct; the default is
  // cloudflare-tunnel with a Cloudflare token, else local. BASE_DOMAIN
  // defaults to CLOUDFLARE_ZONE. AUTHENTIK_BOOTSTRAP_PASSWORD is the apps'
  // first admin password, ADMIN_PASSWORD when left out.
  "BUNDLE",
  "BUNDLE_ACCESS",
  "BASE_DOMAIN",
  "ADMIN_EMAIL",
  "STORAGE_CLASS",
  "AUTHENTIK_BOOTSTRAP_PASSWORD",
] as const;

export type InstallSeedKey = (typeof INSTALL_SEED_KEYS)[number];

export type SeedBundleAccess = "cloudflare-tunnel" | "local" | "direct";

// The Secret's keys parsed and grouped. Each group is present when any of
// its keys is; a group missing a key it needs is reported as a failed item,
// not dropped.
export interface InstallSeed {
  version: 1;
  adminPassword?: string;
  publicUrl?: string;
  cloudflare?: {
    token: string;
    zone: string;
    accountId?: string;
    accessApps?: CloudflareAccessPolicy;
  };
  entra?: { tenantId: string; clientId: string; clientSecret: string; adminGroups?: string[] };
  storageTarget?: {
    protocol: StorageProtocol;
    url: string;
    path?: string;
    endpoint?: string;
    user?: string;
    secret?: string;
  };
  smtp?: {
    preset: EmailPreset;
    host?: string;
    port?: number;
    security?: SmtpSecurity;
    user?: string;
    password?: string;
    from: string;
    to: string[];
  };
  oidc?: { issuer: string; clientId: string; clientSecret: string; label?: string; adminGroups?: string[] };
  authentikBootstrapPassword?: string;
  bundle?: {
    include: "default" | string[];
    access?: SeedBundleAccess;
    baseDomain?: string;
    adminEmail?: string;
    storageClass?: string;
  };
}

// In the order they are applied: boot first, then /apply.
export type SeedItemId =
  "admin-password" | "public-url" | "oidc" | "cloudflare" | "entra" | "storage-target" | "email" | "bundle";

export const SEED_ITEM_LABELS: Record<SeedItemId, string> = {
  "admin-password": "Admin password",
  "public-url": "Public URL",
  oidc: "OIDC sign-in",
  cloudflare: "Cloudflare",
  entra: "Microsoft Entra ID",
  "storage-target": "Backup storage target",
  email: "Email notifications",
  bundle: "Deploy bundle",
};

// pending: waits for /apply. skipped: nothing to do (the admin had already
// signed in, the setting is locked by the environment); `detail` says why.
export type SeedItemState = "pending" | "applied" | "failed" | "skipped";

export interface SeedItemResult {
  id: SeedItemId;
  label: string;
  state: SeedItemState;
  // One or two sentences, also when applied ("Created connector
  // cloudflare (example.com) and started the tunnel."). A failure carries the
  // route's error message; never a value from the file.
  detail: string;
  // When it ran; absent while pending.
  at?: string;
}

export interface InstallSeedView {
  // none: this install was not set up from a file (or its summary was
  // dismissed and the record cleared by a reset). pending: some items wait
  // for /apply. done: every item has run.
  state: "none" | "pending" | "done";
  importedAt?: string;
  appliedAt?: string;
  // Username /apply ran as.
  appliedBy?: string;
  items: SeedItemResult[];
  // The summary was closed; the welcome page stops showing it.
  dismissed: boolean;
}

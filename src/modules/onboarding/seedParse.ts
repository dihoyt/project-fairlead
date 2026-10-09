import type { StorageProtocol } from "../../contracts/connectors.js";
import { EMAIL_PRESETS, type EmailPreset, type SmtpSecurity } from "../../contracts/notify.js";
import {
  INSTALL_SEED_KEYS,
  type InstallSeed,
  type InstallSeedKey,
  type SeedBundleAccess,
  type SeedItemId,
} from "../../contracts/onboarding.js";

export type SeedEnv = Partial<Record<InstallSeedKey, string>>;

export interface ParsedSeed {
  seed: InstallSeed;
  // Items the file asks for but can't be applied as written, with why. The
  // reason names keys, never a value.
  problems: Partial<Record<SeedItemId, string>>;
}

// The Secret's data, decoded. Keys outside the contract's list are dropped:
// the installer refuses them, so one here was put there some other way.
export function seedEnvFromSecret(data: Record<string, string> | undefined): SeedEnv {
  const env: SeedEnv = {};
  for (const key of INSTALL_SEED_KEYS) {
    const raw = data?.[key];
    if (raw === undefined) continue;
    const value = Buffer.from(raw, "base64").toString("utf8").trim();
    if (value !== "") env[key] = value;
  }
  return env;
}

const list = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const missing = (env: SeedEnv, keys: InstallSeedKey[]): string | null => {
  const absent = keys.filter((key) => !env[key]);
  if (absent.length === 0) return null;
  return `${absent.join(" and ")} ${absent.length === 1 ? "is" : "are"} missing from the file.`;
};

const any = (env: SeedEnv, keys: InstallSeedKey[]) => keys.some((key) => env[key] !== undefined);

const SCHEMES: Record<string, StorageProtocol> = { nfs: "nfs", s3: "s3", cifs: "smb", smb: "smb" };
const ACCESS_APPS = ["never", "always", "per-app"] as const;
const BUNDLE_ACCESS: readonly SeedBundleAccess[] = ["cloudflare-tunnel", "local", "direct"];
const SECURITY: readonly SmtpSecurity[] = ["starttls", "tls", "none"];

export function parseSeed(env: SeedEnv): ParsedSeed {
  const seed: InstallSeed = { version: 1 };
  const problems: ParsedSeed["problems"] = {};

  if (env.ADMIN_PASSWORD) seed.adminPassword = env.ADMIN_PASSWORD;
  if (env.PUBLIC_URL) seed.publicUrl = env.PUBLIC_URL;

  if (any(env, ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ZONE", "CLOUDFLARE_ACCESS_APPS"])) {
    const access = env.CLOUDFLARE_ACCESS_APPS;
    const gap = missing(env, ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE"]);
    if (gap) problems.cloudflare = gap;
    else if (access && !(ACCESS_APPS as readonly string[]).includes(access))
      problems.cloudflare = "CLOUDFLARE_ACCESS_APPS must be never, always or per-app.";
    else
      seed.cloudflare = {
        token: env.CLOUDFLARE_API_TOKEN!,
        zone: env.CLOUDFLARE_ZONE!,
        ...(env.CLOUDFLARE_ACCOUNT_ID ? { accountId: env.CLOUDFLARE_ACCOUNT_ID } : {}),
        ...(access ? { accessApps: access as (typeof ACCESS_APPS)[number] } : {}),
      };
  }

  if (any(env, ["ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET", "ENTRA_ADMIN_GROUPS"])) {
    const gap = missing(env, ["ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET"]);
    if (gap) problems.entra = gap;
    else {
      const groups = list(env.ENTRA_ADMIN_GROUPS);
      seed.entra = {
        tenantId: env.ENTRA_TENANT_ID!,
        clientId: env.ENTRA_CLIENT_ID!,
        clientSecret: env.ENTRA_CLIENT_SECRET!,
        ...(groups.length ? { adminGroups: groups } : {}),
      };
    }
  }

  if (any(env, ["STORAGE_URL", "STORAGE_PATH", "STORAGE_ENDPOINT", "STORAGE_USER", "STORAGE_SECRET"])) {
    const scheme = /^([a-z0-9]+):\/\//i.exec(env.STORAGE_URL ?? "")?.[1]?.toLowerCase();
    const protocol = scheme === undefined ? undefined : SCHEMES[scheme];
    const gap = missing(env, ["STORAGE_URL"]);
    if (gap) problems["storage-target"] = gap;
    else if (!protocol) problems["storage-target"] = "STORAGE_URL must start with nfs://, s3:// or cifs://.";
    else if (protocol !== "nfs" && (!env.STORAGE_USER || !env.STORAGE_SECRET))
      problems["storage-target"] =
        protocol === "s3"
          ? "An S3 target needs STORAGE_USER and STORAGE_SECRET (the access key pair)."
          : "An SMB target needs STORAGE_USER and STORAGE_SECRET.";
    else
      seed.storageTarget = {
        protocol,
        url: env.STORAGE_URL!,
        ...(env.STORAGE_PATH ? { path: env.STORAGE_PATH } : {}),
        ...(env.STORAGE_ENDPOINT ? { endpoint: env.STORAGE_ENDPOINT } : {}),
        ...(env.STORAGE_USER ? { user: env.STORAGE_USER } : {}),
        ...(env.STORAGE_SECRET ? { secret: env.STORAGE_SECRET } : {}),
      };
  }

  const smtpKeys: InstallSeedKey[] = [
    "SMTP_PRESET",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_SECURITY",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM",
    "SMTP_TO",
  ];
  if (any(env, smtpKeys)) {
    const preset = (env.SMTP_PRESET ?? "smtp") as EmailPreset;
    const info = EMAIL_PRESETS[preset] as (typeof EMAIL_PRESETS)[EmailPreset] | undefined;
    const port = env.SMTP_PORT === undefined ? undefined : Number(env.SMTP_PORT);
    const to = list(env.SMTP_TO);
    if (!info || info.mode === "oauth")
      problems.email = `SMTP_PRESET must be an SMTP preset or entra; the sign-in-to-send presets need a browser.`;
    else if (to.length === 0 || !env.SMTP_FROM) problems.email = missing(env, ["SMTP_FROM", "SMTP_TO"])!;
    else if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536))
      problems.email = "SMTP_PORT must be a port number.";
    else if (env.SMTP_SECURITY && !(SECURITY as readonly string[]).includes(env.SMTP_SECURITY))
      problems.email = "SMTP_SECURITY must be starttls, tls or none.";
    else
      seed.smtp = {
        preset,
        ...(env.SMTP_HOST ? { host: env.SMTP_HOST } : {}),
        ...(port !== undefined ? { port } : {}),
        ...(env.SMTP_SECURITY ? { security: env.SMTP_SECURITY as SmtpSecurity } : {}),
        ...(env.SMTP_USER ? { user: env.SMTP_USER } : {}),
        ...(env.SMTP_PASSWORD ? { password: env.SMTP_PASSWORD } : {}),
        from: env.SMTP_FROM,
        to,
      };
  }

  if (any(env, ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_LABEL", "OIDC_ADMIN_GROUPS"])) {
    const gap = missing(env, ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"]);
    if (gap) problems.oidc = gap;
    else {
      const groups = list(env.OIDC_ADMIN_GROUPS);
      seed.oidc = {
        issuer: env.OIDC_ISSUER!,
        clientId: env.OIDC_CLIENT_ID!,
        clientSecret: env.OIDC_CLIENT_SECRET!,
        ...(env.OIDC_LABEL ? { label: env.OIDC_LABEL } : {}),
        ...(groups.length ? { adminGroups: groups } : {}),
      };
    }
  }

  if (env.AUTHENTIK_BOOTSTRAP_PASSWORD) seed.authentikBootstrapPassword = env.AUTHENTIK_BOOTSTRAP_PASSWORD;

  if (env.BUNDLE) {
    const access = (env.BUNDLE_ACCESS ??
      (env.CLOUDFLARE_API_TOKEN ? "cloudflare-tunnel" : "local")) as SeedBundleAccess;
    const baseDomain = env.BASE_DOMAIN ?? env.CLOUDFLARE_ZONE;
    const include = env.BUNDLE.trim().toLowerCase() === "default" ? "default" : list(env.BUNDLE);
    if (!BUNDLE_ACCESS.includes(access)) problems.bundle = "BUNDLE_ACCESS must be cloudflare-tunnel, local or direct.";
    else if (access === "cloudflare-tunnel" && !env.CLOUDFLARE_API_TOKEN)
      problems.bundle =
        "BUNDLE_ACCESS=cloudflare-tunnel needs the Cloudflare keys (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE).";
    else if (!baseDomain) problems.bundle = "BASE_DOMAIN is missing from the file (or set CLOUDFLARE_ZONE).";
    else if (!env.ADMIN_EMAIL) problems.bundle = "ADMIN_EMAIL is missing from the file.";
    else if (!env.AUTHENTIK_BOOTSTRAP_PASSWORD && !env.ADMIN_PASSWORD)
      problems.bundle = "AUTHENTIK_BOOTSTRAP_PASSWORD (or ADMIN_PASSWORD) is missing from the file.";
    else
      seed.bundle = {
        include,
        access,
        baseDomain,
        adminEmail: env.ADMIN_EMAIL,
        ...(env.STORAGE_CLASS ? { storageClass: env.STORAGE_CLASS } : {}),
      };
  }

  return { seed, problems };
}

import type { Database } from "better-sqlite3";
import type { ZodType } from "zod";
import type { SettingType, SettingValue, SettingView } from "../contracts/auth.js";
import type { Setting, SettingSpec, SettingsRegistry } from "../contracts/platform.js";
import { product } from "../product.js";
import { parseCidrList } from "./net.js";

// Every setting an admin can change from the UI, the platform's and every
// module's, in one registry. The value a caller gets is the UI's override if
// there is one, else the process environment's, else the built-in default,
// so an install configured entirely through env vars keeps working untouched.
//
// Some configuration can only come from the environment: anything that
// decides whether the UI itself can be reached or trusted. An admin who
// could set those from the page could also lock every admin out of it.

export type SettingSource = "ui" | "env" | "default";

export class SettingError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Definition {
  key: string;
  group: string;
  label: string;
  help: string;
  type: SettingType;
  env?: string;
  envOnly?: boolean;
  default: unknown;
  options?: readonly string[];
  // One parser for both directions in: a string from the environment and a
  // JSON value from the form. Throws a SettingError naming what was wrong.
  coerce(raw: unknown): unknown;
}

interface BuiltIn {
  key: string;
  group: string;
  label: string;
  help: string;
  type: SettingType;
  env?: string;
  default: SettingValue;
  options?: readonly string[];
  min?: number;
  max?: number;
}

const BUILT_IN: readonly BuiltIn[] = [
  {
    key: "site.name",
    group: "General",
    label: "Site name",
    help: "Shown in the browser tab, the sign-in page and the header.",
    type: "string",
    env: "SITE_NAME",
    default: product.displayName,
  },
  {
    key: "auth.password.enabled",
    group: "Password sign-in",
    label: "Allow password sign-in",
    help: "Local accounts sign in with a username and password.",
    type: "boolean",
    env: "AUTH_PASSWORD_ENABLED",
    default: true,
  },
  {
    key: "auth.password.networks",
    group: "Password sign-in",
    label: "Trusted networks for password sign-in",
    help: "Optional. When set, password sign-in only works from these addresses or CIDR ranges, for users without a rule of their own. Empty allows anywhere.",
    type: "cidrs",
    env: "AUTH_PASSWORD_NETWORKS",
    default: [],
  },
  {
    key: "auth.totp.enabled",
    group: "Password sign-in",
    label: "Allow two-factor codes",
    help: "Local accounts can add an authenticator app. Needs SECRETS_KEY. OIDC accounts use their provider's MFA instead.",
    type: "boolean",
    env: "AUTH_TOTP_ENABLED",
    default: false,
  },
  {
    key: "auth.totp.require",
    group: "Password sign-in",
    label: "Require two-factor codes for",
    help: "Accounts in scope must set up an authenticator app at their next password sign-in.",
    type: "enum",
    env: "AUTH_TOTP_REQUIRE",
    default: "none",
    options: ["none", "admins", "all"],
  },
  {
    key: "auth.oidc.enabled",
    group: "OIDC sign-in",
    label: "Allow OIDC sign-in",
    help: "Sign in through an OpenID Connect provider such as Entra ID, Google, Keycloak or Authentik.",
    type: "boolean",
    env: "OIDC_ENABLED",
    default: false,
  },
  {
    key: "auth.oidc.label",
    group: "OIDC sign-in",
    label: "Button label",
    help: "Text of the sign-in button.",
    type: "string",
    env: "OIDC_LABEL",
    default: "Sign in with SSO",
  },
  {
    key: "auth.oidc.issuer",
    group: "OIDC sign-in",
    label: "Issuer URL",
    help: "The provider's issuer; /.well-known/openid-configuration is read from it.",
    type: "url",
    env: "OIDC_ISSUER_URL",
    default: "",
  },
  {
    key: "auth.oidc.clientId",
    group: "OIDC sign-in",
    label: "Client ID",
    help: "The client secret is set separately and is never shown again.",
    type: "string",
    env: "OIDC_CLIENT_ID",
    default: "",
  },
  {
    key: "auth.oidc.scopes",
    group: "OIDC sign-in",
    label: "Scopes",
    help: "Space-separated. openid is always included.",
    type: "string",
    env: "OIDC_SCOPES",
    default: "openid profile email",
  },
  {
    key: "auth.oidc.usernameClaim",
    group: "OIDC sign-in",
    label: "Username claim",
    help: "Claim that becomes the username of an account created at first sign-in.",
    type: "string",
    env: "OIDC_USERNAME_CLAIM",
    default: "preferred_username",
  },
  {
    key: "auth.oidc.groupsClaim",
    group: "OIDC sign-in",
    label: "Groups claim",
    help: "Claim holding the user's groups, used for the admin and allowed groups below.",
    type: "string",
    env: "OIDC_GROUPS_CLAIM",
    default: "groups",
  },
  {
    key: "auth.oidc.autoProvision",
    group: "OIDC sign-in",
    label: "Create accounts at first sign-in",
    help: "Off: an admin must create the account first, and the first OIDC sign-in with a matching username or email is linked to it.",
    type: "boolean",
    env: "OIDC_AUTO_PROVISION",
    default: false,
  },
  {
    key: "auth.oidc.allowedGroups",
    group: "OIDC sign-in",
    label: "Allowed groups",
    help: "Optional. When set, only members of these groups may sign in through OIDC.",
    type: "list",
    env: "OIDC_ALLOWED_GROUPS",
    default: [],
  },
  {
    key: "auth.oidc.adminGroups",
    group: "OIDC sign-in",
    label: "Admin groups",
    help: "Members of these groups are admins while signed in through OIDC.",
    type: "list",
    env: "OIDC_ADMIN_GROUPS",
    default: [],
  },
  {
    key: "auth.oidc.networks",
    group: "OIDC sign-in",
    label: "Trusted networks for OIDC sign-in",
    help: "Optional. When set, OIDC sign-in only works from these addresses or CIDR ranges, for users without a rule of their own. Empty allows anywhere.",
    type: "cidrs",
    env: "OIDC_NETWORKS",
    default: [],
  },
  {
    key: "auth.session.idleDays",
    group: "Sessions",
    label: "Sign out after inactivity (days)",
    help: "A session that is used keeps extending; one left unused this long ends.",
    type: "number",
    env: "SESSION_IDLE_DAYS",
    default: 14,
    min: 1,
    max: 365,
  },
  {
    key: "auth.session.maxDays",
    group: "Sessions",
    label: "Sign out after (days), however active",
    help: "An absolute lifetime: a session this old ends even if it is used every day.",
    type: "number",
    env: "SESSION_MAX_DAYS",
    default: 30,
    min: 1,
    max: 365,
  },
  {
    key: "auth.oidc.recheckHours",
    group: "Sessions",
    label: "Re-check OIDC sign-ins every (hours)",
    help: "Sends OIDC sessions back through the provider this often, so someone disabled there is signed out here. 0 never re-checks.",
    type: "number",
    env: "OIDC_RECHECK_HOURS",
    default: 0,
    min: 0,
    max: 720,
  },
];

// Shown read-only in the admin UI so an operator can see what the
// environment decided, without being able to change it from the page.
const ENV_ONLY: readonly { name: string; secret?: boolean; help: string }[] = [
  { name: "PUBLIC_ORIGIN", help: "Where browsers reach this install. Sets the OIDC redirect URI and secure cookies." },
  { name: "TRUSTED_PROXIES", help: "Peers whose client-IP header is believed." },
  { name: "CLIENT_IP_HEADER", help: "Which header carries the client IP from a trusted proxy." },
  { name: "SECRETS_KEY", secret: true, help: "Encrypts secrets stored in the database." },
  {
    name: "BOOTSTRAP_ADMIN_PASSWORD",
    secret: true,
    help: "First boot only: the initial password for the admin account.",
  },
  { name: "ADMIN_USERS", help: "Usernames or emails that are always admins." },
  { name: "ADMIN_GROUPS", help: "Groups whose members are always admins." },
  { name: "DATA_DIR", help: "Where the database and other state live." },
  { name: "DB_PATH", help: "Overrides the database file's location." },
  { name: "DRAIN_MS", help: "How long an updating pod waits for in-flight requests." },
  { name: "GIT_SHA", help: "The build this install is running." },
];

function splitList(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function builtInCoerce(def: BuiltIn): (raw: unknown) => SettingValue {
  return (raw) => {
    const bad = (why: string) => new SettingError(400, `${def.label}: ${why}`);
    switch (def.type) {
      case "boolean":
        if (typeof raw === "boolean") return raw;
        if (typeof raw === "string" && /^(1|true|yes|on)$/i.test(raw.trim())) return true;
        if (typeof raw === "string" && /^(0|false|no|off)$/i.test(raw.trim())) return false;
        throw bad("must be on or off.");
      case "number": {
        const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
        if (!Number.isFinite(value)) throw bad("must be a number.");
        if (def.min !== undefined && value < def.min) throw bad(`must be at least ${def.min}.`);
        if (def.max !== undefined && value > def.max) throw bad(`must be at most ${def.max}.`);
        return value;
      }
      case "list":
      case "cidrs": {
        const entries = Array.isArray(raw)
          ? raw.map((entry) => String(entry).trim()).filter(Boolean)
          : typeof raw === "string"
            ? splitList(raw)
            : null;
        if (entries === null) throw bad("must be a list.");
        if (def.type === "cidrs") {
          try {
            parseCidrList(entries);
          } catch (err) {
            throw bad((err as Error).message);
          }
        }
        return [...new Set(entries)];
      }
      case "url": {
        if (typeof raw !== "string") throw bad("must be a URL.");
        const value = raw.trim().replace(/\/+$/, "");
        if (value === "") return "";
        let parsed: URL;
        try {
          parsed = new URL(value);
        } catch {
          throw bad("must be a URL.");
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw bad("must be an http or https URL.");
        return value;
      }
      case "enum":
        if (typeof raw !== "string" || !def.options?.includes(raw))
          throw bad(`must be one of ${def.options?.join(", ")}.`);
        return raw;
      case "string":
        if (typeof raw !== "string") throw bad("must be text.");
        return raw.trim();
      case "json":
        throw bad("is not editable.");
    }
  };
}

interface ZodDef {
  type: string;
  innerType?: ZodType;
  element?: ZodType;
  entries?: Record<string, string>;
}

const zodDef = (schema: ZodType): ZodDef => (schema as unknown as { def: ZodDef }).def;

// What a module's schema looks like to the admin form. Wrappers such as
// .default() and .optional() describe the value they wrap.
export function settingTypeOf(schema: ZodType): { type: SettingType; options?: string[] } {
  let def = zodDef(schema);
  while (def.innerType && ["default", "optional", "nullable", "prefault", "readonly"].includes(def.type)) {
    def = zodDef(def.innerType);
  }
  switch (def.type) {
    case "string":
      return { type: "string" };
    case "boolean":
      return { type: "boolean" };
    case "number":
      return { type: "number" };
    case "enum":
      return { type: "enum", options: Object.values(def.entries ?? {}) };
    case "array":
      return def.element && zodDef(def.element).type === "string" ? { type: "list" } : { type: "json" };
    default:
      return { type: "json" };
  }
}

// An environment variable is always a string; these are the readings of
// one a schema might accept, most literal first.
function stringCandidates(raw: string, type: SettingType): unknown[] {
  const out: unknown[] = [];
  const trimmed = raw.trim();
  if (type === "boolean") {
    if (/^(1|true|yes|on)$/i.test(trimmed)) out.push(true);
    if (/^(0|false|no|off)$/i.test(trimmed)) out.push(false);
  }
  if (type === "number" && trimmed !== "") out.push(Number(trimmed));
  let json: unknown[] = [];
  try {
    json = [JSON.parse(raw)];
  } catch {
    // Not JSON; the literal readings are all there is.
  }
  // A JSON array would also split on its commas into strings a list schema
  // accepts, so it is read as JSON first.
  if (type === "list") out.push(...(trimmed.startsWith("[") ? json : []), splitList(raw));
  out.push(type === "string" ? trimmed : raw, ...json);
  return out;
}

function fromSpec<T>(spec: SettingSpec<T>): Definition {
  const shape = settingTypeOf(spec.schema);
  return {
    key: spec.key,
    group: spec.key.split(".")[0] ?? spec.key,
    label: spec.label,
    help: spec.help ?? "",
    type: shape.type,
    ...(spec.env ? { env: spec.env } : {}),
    ...(spec.envOnly ? { envOnly: true } : {}),
    default: spec.default,
    ...(shape.options ? { options: shape.options } : {}),
    coerce(raw) {
      const candidates = typeof raw === "string" ? stringCandidates(raw, shape.type) : [raw];
      let reason = "is not a valid value.";
      for (const candidate of candidates) {
        const parsed = spec.schema.safeParse(candidate);
        if (parsed.success) return parsed.data;
        reason = parsed.error.issues[0]?.message ?? reason;
      }
      throw new SettingError(400, `${spec.label}: ${reason}`);
    },
  };
}

interface Resolved {
  value: unknown;
  source: SettingSource;
  // Set when an env value was present but unusable, so the admin page can
  // say why the default is in force instead of silently showing it.
  envError?: string;
}

export interface PlatformSettings extends SettingsRegistry {
  definition(key: string): Definition;
  get(key: string): unknown;
  string(key: string): string;
  bool(key: string): boolean;
  number(key: string): number;
  list(key: string): string[];
  // What a setting would be if its UI override were removed, so a reset can
  // be checked for consequences before it happens.
  fallback(key: string): unknown;
  set(key: string, raw: unknown, by: string): unknown;
  reset(key: string): void;
  describe(): SettingView[];
  describeEnvironment(): Array<{ name: string; help: string; value: string; set: boolean }>;
}

export function createSettings(db: Database, orgId: string): PlatformSettings {
  const definitions = new Map<string, Definition>();
  for (const def of BUILT_IN) definitions.set(def.key, { ...def, coerce: builtInCoerce(def) });

  const definition = (key: string): Definition => {
    const found = definitions.get(key);
    if (found === undefined) throw new SettingError(404, `No setting named "${key}".`);
    return found;
  };

  const override = (key: string): unknown => {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    if (row === undefined) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return undefined;
    }
  };

  const fromEnv = (def: Definition): Resolved | undefined => {
    const raw = def.env ? process.env[def.env] : undefined;
    if (raw === undefined || raw.trim() === "") return undefined;
    try {
      return { value: def.coerce(raw), source: "env" };
    } catch (err) {
      return { value: def.default, source: "default", envError: (err as Error).message };
    }
  };

  const resolve = (def: Definition): Resolved => {
    if (!def.envOnly) {
      const stored = override(def.key);
      if (stored !== undefined) {
        try {
          return { value: def.coerce(stored), source: "ui" };
        } catch {
          // A stored value the current code no longer accepts falls through
          // to the environment rather than failing every read of it.
        }
      }
    }
    return fromEnv(def) ?? { value: def.default, source: "default" };
  };

  const get = (key: string) => resolve(definition(key)).value;

  const editable = (key: string): Definition => {
    const def = definition(key);
    if (def.envOnly) throw new SettingError(409, `${def.label} can only be set in the environment.`);
    return def;
  };

  return {
    declare<T>(spec: SettingSpec<T>): Setting<T> {
      if (definitions.has(spec.key)) throw new Error(`Setting "${spec.key}" is declared twice.`);
      const def = fromSpec(spec);
      definitions.set(spec.key, def);
      return {
        key: spec.key,
        get: () => resolve(def).value as T,
        source: () => resolve(def).source,
      };
    },
    definition,
    get,
    string: (key) => String(get(key)),
    bool: (key) => get(key) === true,
    number: (key) => Number(get(key)),
    list(key) {
      const value = get(key);
      return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
    },
    fallback(key) {
      const def = definition(key);
      const env = fromEnv(def);
      return env?.source === "env" ? env.value : def.default;
    },
    set(key, raw, by) {
      const def = editable(key);
      const value = def.coerce(raw);
      db.prepare(
        `INSERT INTO settings (key, org_id, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      ).run(key, orgId, JSON.stringify(value), by, Date.now());
      return value;
    },
    reset(key) {
      editable(key);
      db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    },
    describe() {
      return [...definitions.values()]
        .filter((def) => !def.envOnly)
        .map((def) => {
          const resolved = resolve(def);
          const envValue = def.env ? process.env[def.env] : undefined;
          return {
            key: def.key,
            group: def.group,
            label: def.label,
            help: def.help,
            type: def.type,
            ...(def.env ? { env: def.env } : {}),
            default: def.default as SettingValue,
            ...(def.options ? { options: def.options } : {}),
            value: resolved.value as SettingValue,
            source: resolved.source,
            ...(envValue !== undefined ? { envValue } : {}),
            ...(resolved.envError ? { envError: resolved.envError } : {}),
          };
        });
    },
    describeEnvironment() {
      const declared = [...definitions.values()]
        .filter((def) => def.envOnly && def.env)
        .map((def) => ({ name: def.env!, help: def.help || def.label }));
      return [...ENV_ONLY, ...declared].map(({ name, help, ...rest }) => {
        const raw = process.env[name];
        const set = raw !== undefined && raw.trim() !== "";
        const secret = "secret" in rest && rest.secret === true;
        return { name, help, set, value: !set ? "" : secret ? "(set)" : raw };
      });
    },
  };
}

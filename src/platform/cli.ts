import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Database } from "better-sqlite3";
import { readConfig } from "../runtime/config.js";
import { openDatabase } from "../runtime/db.js";
import { createLogger } from "../runtime/log.js";
import { applyMigrations, DEFAULT_ORG_ID, runtimeMigrations } from "../runtime/migrations.js";
import { createAudit } from "./audit.js";
import { generateTempPassword, hashPassword } from "./auth/passwords.js";
import { createLoginLimits } from "./auth/limiter.js";
import { revokeAllSessions } from "./auth/sessions.js";
import { clearTotp } from "./auth/totp.js";
import { createUser, normalizeUsername, updateUser, userByUsername, usernameProblem } from "./auth/users.js";
import type { Core } from "./core.js";
import { platformMigrations } from "./migrations.js";
import { createSecrets } from "./secrets.js";
import { createSettings } from "./settings.js";

// Break-glass, run inside the pod:
//
//   kubectl exec deploy/<release> -- node dist/platform/cli.js reset-admin [username]
//
// Whoever can exec into the pod already owns everything the install can
// reach, so this asks for nothing more. It undoes every way an admin can
// lock themselves out from the UI: a forgotten password, a lost
// authenticator, a network rule that excludes where they are, a disabled
// account, and password sign-in turned off.

const USAGE = ["Usage:", "  node dist/platform/cli.js reset-admin [username]"].join("\n");

export interface ResetOutcome {
  username: string;
  created: boolean;
  password: string;
  // False when the environment itself turns password sign-in off.
  passwordsOn: boolean;
}

export function cliCore(db: Database): Core {
  const log = createLogger("cli");
  return {
    db,
    orgId: DEFAULT_ORG_ID,
    settings: createSettings(db, DEFAULT_ORG_ID),
    secrets: createSecrets(db, DEFAULT_ORG_ID),
    audit: createAudit(db, DEFAULT_ORG_ID, log),
    log,
    limits: createLoginLimits(),
  };
}

export async function resetAdmin(core: Core, rawUsername: string): Promise<ResetOutcome> {
  const username = normalizeUsername(rawUsername || "admin");
  const problem = usernameProblem(username);
  if (problem !== null) throw new Error(problem);

  const password = generateTempPassword();
  const passwordHash = await hashPassword(password);
  const existing = userByUsername(core.db, username);
  const account =
    existing === null
      ? createUser(core.db, { orgId: core.orgId, username, passwordHash, role: "admin", mustChangePassword: true })
      : updateUser(core.db, existing.id, {
          passwordHash,
          role: "admin",
          disabled: false,
          mustChangePassword: true,
          allowedNetworks: [],
        })!;
  revokeAllSessions(core, account.id);
  clearTotp(core, account.id);

  // Only a UI override can be undone from here. If the environment itself
  // turns password sign-in off, that is the operator's decision and has to
  // be changed where it was made.
  core.settings.reset("auth.password.enabled");
  core.settings.reset("auth.password.networks");

  core.audit.record({ actor: username, action: "admin.reset-admin", detail: "break-glass CLI", result: "ok" });
  return { username, created: existing === null, password, passwordsOn: core.settings.bool("auth.password.enabled") };
}

async function main(argv: string[]): Promise<number> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const [command, arg] = argv;
  if (command !== "reset-admin") {
    console.error(USAGE);
    return 2;
  }
  const db = openDatabase(readConfig().dbPath);
  try {
    applyMigrations(db, "runtime", runtimeMigrations);
    applyMigrations(db, "platform", platformMigrations);
    const outcome = await resetAdmin(cliCore(db), arg ?? "");
    console.log(`${outcome.created ? "Created" : "Reset"} admin account "${outcome.username}".`);
    console.log(`Temporary password (shown once, must be changed at sign-in): ${outcome.password}`);
    console.log(
      "Network rules and two-factor for this account, and network rules for password sign-in, were cleared; its sessions were ended."
    );
    if (!outcome.passwordsOn) {
      console.log(
        "WARNING: AUTH_PASSWORD_ENABLED turns password sign-in off in the environment; unset it to sign in with this password."
      );
    }
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  } finally {
    db.close();
  }
}

// Only when run as a program, so tests can import resetAdmin.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}

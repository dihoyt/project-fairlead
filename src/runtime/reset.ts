import type { Database } from "better-sqlite3";
import {
  RESET_CONFIRM_WORD,
  RESET_SCOPES,
  type ResetRequest,
  type ResetResult,
  type ResetScope,
} from "../contracts/reset.js";
import type { Platform } from "../contracts/platform.js";
import type { Logger, ResetRegistry } from "../contracts/runtime.js";
import { HttpError } from "./http.js";
import { errorMessage } from "./log.js";

// Sign-in and the public URL are never part of "settings": clearing them from
// a button could lock the admin out. The break-glass CLI covers those.
const KEPT_SETTING_PREFIXES = ["auth.", "site."];

export interface ResetDeps {
  db: Database;
  platform: Platform;
  registry: ResetRegistry;
  log: Logger;
}

export function parseResetRequest(body: unknown): ResetRequest {
  const raw = (body ?? {}) as Partial<ResetRequest>;
  if (raw.confirm !== RESET_CONFIRM_WORD) throw new HttpError(400, `Type ${RESET_CONFIRM_WORD} to confirm.`);
  if (!Array.isArray(raw.scopes) || raw.scopes.length === 0) throw new HttpError(400, "Choose what to reset.");
  const known = new Set<string>(RESET_SCOPES);
  const unknown = raw.scopes.filter((scope) => !known.has(scope));
  if (unknown.length > 0) throw new HttpError(400, `Unknown reset scope: ${unknown.join(", ")}.`);
  return { scopes: [...new Set(raw.scopes)], confirm: raw.confirm };
}

// Every database change commits together or not at all. Secrets live behind
// an async store, so they go after the commit; if one of those fails the
// committed work stays and the error names what is left.
export async function runReset(deps: ResetDeps, request: ResetRequest, actor: string): Promise<ResetResult> {
  const { db, platform, registry } = deps;
  const chosen = RESET_SCOPES.filter((scope) => request.scopes.includes(scope));
  const handlers = registry.list();
  const claimed = handlers.flatMap((handler) => handler.settingKeys ?? []);
  const forScope = (scope: ResetScope) => handlers.filter((handler) => handler.scope === scope);

  const counts = new Map<ResetScope, number>();
  db.transaction(() => {
    for (const scope of chosen) {
      let cleared = 0;
      if (scope === "settings") {
        cleared += platform.clearSettings({ except: claimed, exceptPrefixes: KEPT_SETTING_PREFIXES });
      } else if (scope === "links") {
        cleared += platform.clearSettings({ only: forScope(scope).flatMap((handler) => handler.settingKeys ?? []) });
      }
      for (const handler of forScope(scope)) cleared += handler.clear?.() ?? 0;
      counts.set(scope, cleared);
    }
  })();

  const failures: string[] = [];
  for (const scope of chosen) {
    for (const handler of forScope(scope)) {
      if (!handler.clearAfter) continue;
      try {
        counts.set(scope, (counts.get(scope) ?? 0) + (await handler.clearAfter()));
      } catch (err) {
        deps.log.error("Reset could not remove stored secrets", { scope, error: errorMessage(err) });
        failures.push(scope);
      }
    }
  }

  let temporaryPassword: string | undefined;
  if (chosen.includes("adminPassword")) {
    try {
      temporaryPassword = await platform.resetAdminPassword();
      counts.set("adminPassword", 1);
    } catch (err) {
      deps.log.error("Reset could not change the admin password", { error: errorMessage(err) });
      failures.push("adminPassword");
    }
  }

  platform.audit.record({
    actor,
    action: "system.reset",
    detail: chosen.join(", "),
    result: failures.length ? "error" : "ok",
  });
  if (failures.length > 0) {
    throw new HttpError(500, `Reset finished, but these parts failed and still need doing: ${failures.join(", ")}.`);
  }

  return {
    cleared: chosen.map((scope) => ({ scope, cleared: counts.get(scope) ?? 0 })),
    kept: RESET_SCOPES.filter((scope) => !chosen.includes(scope)),
    ...(temporaryPassword !== undefined ? { temporaryPassword } : {}),
    wizardReopens: chosen.includes("onboarding"),
  };
}

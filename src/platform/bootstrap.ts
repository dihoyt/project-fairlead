import { hashPasswordSync } from "./auth/passwords.js";
import { createUser } from "./auth/users.js";
import type { Core } from "./core.js";

// First boot only: an install with no accounts gets "admin", with the
// password the operator put in BOOTSTRAP_ADMIN_PASSWORD, which has to be
// changed at the first sign-in. After that the variable is ignored, so
// leaving it in a Secret cannot reset anything. The count and the insert
// share one IMMEDIATE transaction so two pods starting together create it
// once.
export function bootstrapAdmin(core: Core): void {
  const empty = () => (core.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n === 0;
  if (!empty()) return;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
  const hash = password === "" ? null : hashPasswordSync(password);
  const created = core.db
    .transaction(() => {
      if (!empty()) return "exists";
      if (hash === null) return "no-password";
      createUser(core.db, {
        orgId: core.orgId,
        username: "admin",
        displayName: "Admin",
        passwordHash: hash,
        role: "admin",
        mustChangePassword: true,
      });
      return "created";
    })
    .immediate();
  if (created === "no-password") {
    core.log.warn("No accounts exist and BOOTSTRAP_ADMIN_PASSWORD is not set: nobody can sign in.");
  } else if (created === "created") {
    core.log.info('Created the first account, "admin" (a new password is required at first sign-in).');
  }
}

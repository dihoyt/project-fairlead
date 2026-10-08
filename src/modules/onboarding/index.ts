import { z } from "zod";
import type { Module, ModuleContext } from "../../contracts/module.js";
import type { OnboardingState, OnboardingStep, OnboardingStepId } from "../../contracts/onboarding.js";
import type { User } from "../../contracts/platform.js";
import { HttpError } from "../../runtime/http.js";
import { collectFindings } from "./findings.js";
import { migrations } from "./migrations.js";

// Wizard order. "password" is never stored: it is done for anyone who can
// reach this API at all, since the platform answers 403 everywhere but
// /api/me and /api/auth/* until a forced password change is made.
export const STEPS: ReadonlyArray<{ id: OnboardingStepId; optional: boolean }> = [
  { id: "password", optional: false },
  { id: "cluster", optional: true },
  { id: "access", optional: true },
  { id: "oidc", optional: true },
  { id: "links", optional: true },
  { id: "hosts", optional: true },
  { id: "checks", optional: true },
  { id: "notifications", optional: true },
  { id: "findings", optional: false },
];

const stepParam = z.enum(STEPS.map((s) => s.id) as [OnboardingStepId, ...OnboardingStepId[]]);
const stepBody = z.object({ action: z.enum(["done", "skip"]) });

type StepState = "done" | "skipped";

export function createStepStore(ctx: Pick<ModuleContext, "db" | "orgId">) {
  const read = ctx.db.prepare<[string], { step: string; state: StepState }>(
    "SELECT step, state FROM onboarding_steps WHERE org_id = ?"
  );
  const write = ctx.db.prepare<[string, string, StepState, string, string]>(
    `INSERT INTO onboarding_steps (org_id, step, state, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (org_id, step) DO UPDATE SET state = excluded.state, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`
  );
  return {
    states(): Map<string, StepState> {
      return new Map(read.all(ctx.orgId).map((row) => [row.step, row.state]));
    },
    set(step: OnboardingStepId, state: StepState, by: string) {
      write.run(ctx.orgId, step, state, by, new Date().toISOString());
    },
  };
}

function steps(stored: Map<string, StepState>, user: User): OnboardingStep[] {
  return STEPS.map(({ id, optional }) => {
    if (id === "password") return { id, optional, done: !user.mustChangePassword, skipped: false };
    const state = stored.get(id);
    return { id, optional, done: state === "done", skipped: state === "skipped" };
  });
}

const mod: Module = {
  id: "onboarding",
  milestone: "A",
  migrations,
  register(ctx) {
    const store = createStepStore(ctx);

    const state = async (user: User): Promise<OnboardingState> => {
      const list = steps(store.states(), user);
      const k8s = ctx.services.has("k8s") ? ctx.services.get("k8s") : undefined;
      return {
        complete: list.every((step) => step.done || step.skipped),
        steps: list,
        findings: await collectFindings(k8s, ctx.backups, ctx.log),
      };
    };

    ctx.route("GET /api/onboarding/state", (req) => state(ctx.identify(req)));

    ctx.route("POST /api/onboarding/steps/:step", async (req, res) => {
      const user = ctx.require(req, res, "admin");
      if (!user) return undefined;
      const step = stepParam.safeParse(req.params.step);
      if (!step.success) throw new HttpError(404, `No first-run step "${req.params.step}".`);
      if (step.data === "password") throw new HttpError(400, "password: follows the account; change it to finish.");
      const body = stepBody.safeParse(req.body ?? {});
      if (!body.success) throw new HttpError(400, 'action: must be "done" or "skip".');
      const next: StepState = body.data.action === "done" ? "done" : "skipped";
      store.set(step.data, next, user.id);
      ctx.audit.record({ actor: user.id, action: `onboarding.${body.data.action}`, target: step.data });
      return state(user);
    });
  },
};

export default mod;

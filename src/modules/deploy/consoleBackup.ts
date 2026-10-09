import type { RouteKey } from "../../contracts/api.js";
import { CONSOLE_BACKUP_APP, type ConsoleNightlyView } from "../../contracts/deploy.js";
import type { CallInput, ModuleContext } from "../../contracts/module.js";
import { HttpError } from "../../runtime/http.js";
import { errorMessage } from "../../runtime/log.js";
import { lastGood, resolveTarget } from "./actions/console-backup.js";
import type { ActionContext } from "./actions/index.js";
import type { DeployConfig } from "./config.js";
import { matches, nextRun, parseCron } from "./cron.js";
import type { Deployer } from "./runner.js";

const TICK_MS = 60_000;
const MINUTE = 60_000;
// How far back a tick looks for a due slot, so a late or skipped tick still
// starts the run it missed.
const CATCH_UP_MINUTES = 10;
export const SCHEDULE_ACTOR = "schedule";

// Scheduled work has no request to call other modules as; console-backup
// never needs to.
const noCall = (<K extends RouteKey>(key: K, _input?: CallInput<K>) =>
  Promise.reject(new HttpError(500, `${key} is not available to a scheduled run.`))) as ActionContext["call"];

export function registerConsoleBackup(
  ctx: ModuleContext,
  deployer: Deployer,
  config: DeployConfig,
  now: () => number = Date.now
): { tick(): Promise<void> } {
  const jobs = () => deployer.list(CONSOLE_BACKUP_APP, 50).filter((job) => job.action === "console-backup");

  // The newest minute within the catch-up window the schedule names.
  const dueSlot = (schedule: string): number | undefined => {
    const cron = parseCron(schedule);
    if (!cron) return undefined;
    const current = Math.floor(now() / MINUTE) * MINUTE;
    for (let i = 0; i < CATCH_UP_MINUTES; i++) {
      const at = current - i * MINUTE;
      if (matches(cron, new Date(at))) return at;
    }
    return undefined;
  };

  async function tick(): Promise<void> {
    const slot = dueSlot(config.consoleBackup());
    if (slot === undefined) return;
    if (jobs().some((job) => Date.parse(job.createdAt) >= slot)) return;
    const rendered = await deployer.renderAction({ kind: "console-backup" }, noCall);
    if (!rendered.plan.allowed) {
      ctx.log.info("Skipping the console's scheduled backup", { reason: rendered.plan.blockedBy });
      return;
    }
    await deployer.startAction(SCHEDULE_ACTOR, { kind: "console-backup" }, noCall);
  }

  ctx.scheduler.every("deploy.console-backup", TICK_MS, () => tick());

  ctx.route("GET /api/deploy/console-backup", async () => {
    const schedule = config.consoleBackup();
    const list = jobs();
    const view: ConsoleNightlyView = { schedule, keep: config.consoleBackupKeep() };
    const plan = await deployer.renderAction({ kind: "console-backup" }, noCall).catch((err: unknown) => ({
      plan: { allowed: false, blockedBy: errorMessage(err) },
    }));
    if (!plan.plan.allowed) view.blockedBy = plan.plan.blockedBy;
    const targets = ctx.services.has("storage-targets") ? ctx.services.get("storage-targets") : undefined;
    const k8s = ctx.services.has("k8s") ? ctx.services.get("k8s") : undefined;
    if (targets && k8s) {
      const target = await resolveTarget(targets, k8s, undefined).catch((err: unknown) => errorMessage(err));
      if (typeof target !== "string") view.target = { connectorId: target.id, name: target.name, url: target.url };
    }
    if (list[0]) view.last = list[0];
    const good = lastGood(list);
    if (good) view.lastGood = good;
    const cron = schedule ? parseCron(schedule) : null;
    const next = cron ? nextRun(cron, now()) : undefined;
    if (next) view.nextAt = next.toISOString();
    return view;
  });

  return { tick };
}

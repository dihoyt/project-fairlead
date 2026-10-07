import { z } from "zod";
import type { Module, ModuleContext } from "../../contracts/module.js";
import { veleroBackupSource } from "./coverage.js";
import { veleroHealthProvider } from "./health.js";
import { migrations } from "./migrations.js";

function register(ctx: ModuleContext): void {
  const grace = ctx.settings.declare({
    key: "velero.graceMinutes",
    label: "Grace before a schedule run counts as missed (minutes)",
    help: "A schedule is late once its last fire time is this far in the past with no backup started.",
    schema: z.number().int().min(1).max(1440),
    default: 60,
    env: "VELERO_GRACE_MINUTES",
  });
  const restoreAge = ctx.settings.declare({
    key: "velero.restoreMaxAgeDays",
    label: "Restore test is stale after (days)",
    help: "The last completed Velero restore warns once it is older than this.",
    schema: z.number().int().min(1).max(3650),
    default: 90,
    env: "VELERO_RESTORE_MAX_AGE_DAYS",
  });

  const k8s = () => ctx.services.get("k8s");
  ctx.health.addProvider(
    veleroHealthProvider(k8s, () => ({
      graceMs: grace.get() * 60_000,
      restoreMaxAgeMs: restoreAge.get() * 86_400_000,
    }))
  );
  ctx.backups.addSource(veleroBackupSource(k8s));
}

const mod: Module = {
  id: "velero",
  milestone: "A",
  migrations,
  register,
};

export default mod;

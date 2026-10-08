import { z } from "zod";
import type { Module } from "../../contracts/module.js";
import { createBackupsProvider, createStorageProvider, type HealthOptions } from "./health.js";
import { createCollector } from "./metrics.js";
import { migrations } from "./migrations.js";
import { createLoader } from "./model.js";
import { createBackupSource } from "./source.js";

const mod: Module = {
  id: "longhorn",
  milestone: "A",
  migrations,
  register(ctx) {
    const uiUrl = ctx.settings.declare({
      key: "longhorn.uiUrl",
      label: "Longhorn UI URL",
      help: "Base URL of the Longhorn UI, for links from checks. Empty: no links.",
      schema: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]),
      default: "",
      env: "LONGHORN_UI_URL",
    });
    ctx.reset.add({ scope: "links", settingKeys: ["longhorn.uiUrl"] });
    const graceMinutes = ctx.settings.declare({
      key: "longhorn.backupGraceMinutes",
      label: "Backup grace (minutes)",
      help: "How long after a scheduled run its backup may still be missing before it counts as missed.",
      schema: z.coerce
        .number()
        .int()
        .min(0)
        .max(7 * 1_440),
      default: 120,
      env: "LONGHORN_BACKUP_GRACE_MINUTES",
    });

    const now = Date.now;
    const load = createLoader(() => ctx.services.get("k8s"), now);
    const options: HealthOptions = {
      load,
      now,
      graceMs: () => graceMinutes.get() * 60_000,
      uiUrl: () => uiUrl.get(),
    };

    ctx.health.addProvider(createStorageProvider(options));
    ctx.health.addProvider(createBackupsProvider(options));
    ctx.metrics.addCollector(createCollector(load));
    ctx.backups.addSource(createBackupSource(load, now));
  },
};

export default mod;

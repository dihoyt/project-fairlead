import { z } from "zod";
import type { Setting, SettingsRegistry } from "../../contracts/platform.js";

export interface BackupsSettings {
  ignore: Setting<string[]>;
  warnFactor: Setting<number>;
  critFactor: Setting<number>;
  targetFreeWarnPercent: Setting<number>;
}

export interface PostureOptions {
  ignore: readonly string[];
  warnFactor: number;
  critFactor: number;
  targetFreeWarnPercent: number;
}

export const DEFAULT_OPTIONS: PostureOptions = {
  ignore: [],
  warnFactor: 1.5,
  critFactor: 4,
  targetFreeWarnPercent: 10,
};

export function declareSettings(settings: SettingsRegistry): BackupsSettings {
  return {
    ignore: settings.declare({
      key: "backups.ignore",
      label: "PVCs not expected to be backed up",
      help: 'Entries are a namespace ("cache") or "namespace/pvc". Matching PVCs that no backup covers are shown as ignored instead of critical; covered ones are still judged.',
      schema: z.array(z.string().trim().min(1).max(320)).max(500),
      default: DEFAULT_OPTIONS.ignore as string[],
    }),
    warnFactor: settings.declare({
      key: "backups.warnFactor",
      label: "Backup overdue: warn after",
      help: "Multiple of the policy's interval the last good backup may reach before it is a warning.",
      schema: z.number().min(1).max(100),
      default: DEFAULT_OPTIONS.warnFactor,
    }),
    critFactor: settings.declare({
      key: "backups.critFactor",
      label: "Backup overdue: critical after",
      help: "Multiple of the policy's interval the last good backup may reach before it is critical.",
      schema: z.number().min(1).max(1000),
      default: DEFAULT_OPTIONS.critFactor,
    }),
    targetFreeWarnPercent: settings.declare({
      key: "backups.targetFreeWarnPercent",
      label: "Backup target low on space below (%)",
      help: "Warn when a backup target's free space is under this share of its total. 0 turns it off.",
      schema: z.number().min(0).max(100),
      default: DEFAULT_OPTIONS.targetFreeWarnPercent,
    }),
  };
}

export function readOptions(s: BackupsSettings): PostureOptions {
  return {
    ignore: s.ignore.get(),
    warnFactor: s.warnFactor.get(),
    critFactor: Math.max(s.critFactor.get(), s.warnFactor.get()),
    targetFreeWarnPercent: s.targetFreeWarnPercent.get(),
  };
}

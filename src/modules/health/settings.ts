import { z } from "zod";
import { CATEGORIES } from "../../contracts/health.js";
import type { Category } from "../../contracts/health.js";
import type { Setting, SettingsRegistry } from "../../contracts/platform.js";

const ruleSchema = z.object({
  warnAbove: z.number().optional(),
  critAbove: z.number().optional(),
  warnBelow: z.number().optional(),
  critBelow: z.number().optional(),
  // Caps how bad this check may look: "warn" turns its crit into warn.
  maxStatus: z.enum(["ok", "warn"]).optional(),
  // Reported as "absent", which never rolls up into a worse status.
  disabled: z.boolean().optional(),
});

export type CheckRule = z.infer<typeof ruleSchema>;

const linkSchema = z.object({ label: z.string().min(1), url: z.url({ protocol: /^https?$/ }) });

const linksSchema = z.partialRecord(z.enum(CATEGORIES as [Category, ...Category[]]), z.array(linkSchema));

export type CategoryLinks = z.infer<typeof linksSchema>;

export interface HealthSettings {
  // Keyed "<providerId>/<checkId>", or "<providerId>/*" for every check of a provider.
  rules: Setting<Record<string, CheckRule>>;
  links: Setting<CategoryLinks>;
  historyDays: Setting<number>;
  demo: Setting<boolean>;
}

export function declareSettings(settings: SettingsRegistry): HealthSettings {
  return {
    rules: settings.declare({
      key: "health.rules",
      label: "Check rules",
      help: 'Per-check overrides, keyed "<provider>/<check>" or "<provider>/*": thresholds on the value, a severity cap, or disabled.',
      schema: z.record(z.string(), ruleSchema),
      default: {},
      env: "HEALTH_RULES",
    }),
    links: settings.declare({
      key: "health.links",
      label: "Native UI links",
      help: "Links shown on each category page, e.g. Rancher for cluster, Longhorn for storage.",
      schema: linksSchema,
      default: {},
      env: "HEALTH_LINKS",
    }),
    historyDays: settings.declare({
      key: "health.historyDays",
      label: "Check history retention (days)",
      schema: z.number().int().min(1).max(3650),
      default: 30,
      env: "HEALTH_HISTORY_DAYS",
    }),
    demo: settings.declare({
      key: "health.demo",
      label: "Demo provider",
      help: "Registers a provider that cycles through every status, for trying the board without a cluster.",
      schema: z.preprocess((v) => (v === "1" ? true : v === "0" ? false : v), z.boolean()),
      default: false,
      env: "HEALTH_DEMO",
      envOnly: true,
    }),
  };
}

export function ruleFor(rules: Record<string, CheckRule>, providerId: string, checkId: string): CheckRule | undefined {
  return rules[`${providerId}/${checkId}`] ?? rules[`${providerId}/*`];
}

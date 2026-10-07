import type { Module } from "../../contracts/module.js";
import { migrations } from "./migrations.js";
import { fleetHealthProvider } from "./provider.js";
import { declareSettings } from "./settings.js";

const mod: Module = {
  id: "fleet",
  milestone: "A",
  migrations,
  register(ctx) {
    const settings = declareSettings(ctx.settings);
    ctx.health.addProvider(
      fleetHealthProvider({
        k8s: () => ctx.services.get("k8s"),
        options: () => ({
          rancherUrl: settings.rancherUrl.get(),
          graceMs: settings.graceMinutes.get() * 60_000,
          severity: settings.severity.get(),
        }),
      })
    );
  },
};

export default mod;

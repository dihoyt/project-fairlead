import type { Module } from "../../contracts/module.js";
import { createLinker } from "./links.js";
import { migrations } from "./migrations.js";
import { clusterHealthProvider } from "./provider.js";
import { declareSettings } from "./settings.js";

const mod: Module = {
  id: "cluster",
  milestone: "A",
  migrations,
  register(ctx) {
    const settings = declareSettings(ctx.settings);
    ctx.health.addProvider(
      clusterHealthProvider({
        k8s: () => ctx.services.get("k8s"),
        thresholds: settings.thresholds,
        link: createLinker(() => ({ rancher: settings.rancherUrl.get(), headlamp: settings.headlampUrl.get() })),
      })
    );
  },
};

export default mod;

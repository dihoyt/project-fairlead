import type { CatalogAppView, CatalogSlot } from "../../contracts/catalog.js";
import type { Module } from "../../contracts/module.js";
import { HttpError } from "../../runtime/http.js";
import { catalog } from "./entries.js";
import { migrations } from "./migrations.js";
import { createCatalogService } from "./service.js";

const SLOTS: readonly CatalogSlot[] = [
  "links",
  "sign-in",
  "cluster-basics",
  "backups",
  "notifications",
  "remote-access",
];

const mod: Module = {
  id: "catalog",
  milestone: "A",
  migrations,
  register(ctx) {
    const service = createCatalogService({ k8s: () => ctx.services.get("k8s"), entries: catalog });
    ctx.services.provide("catalog", service);

    const views = async (refresh: boolean): Promise<CatalogAppView[]> => {
      const report = await service.discover(refresh);
      return service.entries().map((entry) => ({
        ...structuredClone(entry),
        detected: report.apps.find((app) => app.appId === entry.id)!,
      }));
    };

    ctx.route("GET /api/catalog/apps", async (req) => {
      const { slot } = req.query;
      if (slot !== undefined && !SLOTS.includes(slot as CatalogSlot)) {
        throw new HttpError(400, `Unknown slot "${slot}" (one of ${SLOTS.join(", ")})`);
      }
      const all = await views(req.query.refresh === "1");
      return slot ? all.filter((app) => app.slots.includes(slot as CatalogSlot)) : all;
    });
    ctx.route("GET /api/catalog/apps/:id", async (req) => {
      const entry = service.get(req.params.id);
      if (!entry) throw new HttpError(404, `No catalog app "${req.params.id}"`);
      const report = await service.discover();
      return { ...structuredClone(entry), detected: report.apps.find((app) => app.appId === entry.id)! };
    });
    ctx.route("GET /api/catalog/discovery", (req) => service.discover(req.query.refresh === "1"));
  },
};

export default mod;

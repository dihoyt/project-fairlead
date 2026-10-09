import type { Module, ModuleContext } from "../../contracts/module.js";
import { HttpError } from "../../runtime/http.js";
import { createStorageKind, type StorageKindDeps } from "./kind.js";
import { migrations } from "./migrations.js";
import { createStorageService } from "./service.js";

export type StorageModuleOptions = Omit<StorageKindDeps, "longhornCheck">;

export function register(ctx: ModuleContext, options: StorageModuleOptions = {}): void {
  const service = createStorageService({
    registry: () => ctx.services.get("connectors"),
    k8s: () => (ctx.services.has("k8s") ? ctx.services.get("k8s") : undefined),
    ...(options.now ? { now: options.now } : {}),
  });
  ctx.services.get("connectors").addKind(createStorageKind({ ...options, longhornCheck: service.longhornCheck }));
  ctx.services.provide("storage-targets", {
    list: service.list,
    get: service.get,
    credentialsSecret: service.credentialsSecret,
  });

  ctx.route("GET /api/connector-storage/targets", () => service.list());
  ctx.route("GET /api/connector-storage/targets/:id", async (req) => {
    const view = await service.get(req.params.id);
    if (!view) throw new HttpError(404, "No such storage target.");
    return view;
  });
}

const mod: Module = {
  id: "connector-storage",
  milestone: "B",
  migrations,
  register: (ctx) => register(ctx),
};

export default mod;

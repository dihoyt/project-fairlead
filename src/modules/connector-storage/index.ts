import type { Module } from "../../contracts/module.js";
import { migrations } from "./migrations.js";

const connectorStorage: Module = {
  id: "connector-storage",
  milestone: "B",
  migrations,
  register(ctx) {
    ctx.services.provide("storage-targets", {
      list: async () => [],
      get: async () => undefined,
      credentialsSecret: async (id) => {
        throw new Error(`No storage target "${id}".`);
      },
    });
  },
};

export default connectorStorage;

import type { Module } from "../../contracts/module.js";
import { Browser } from "./browser.js";
import { declareLinks } from "./links.js";
import { followLogs, readLogs } from "./logs.js";
import { migrations } from "./migrations.js";

const mod: Module = {
  id: "workloads",
  milestone: "A",
  migrations,
  register(ctx) {
    const k8s = () => ctx.services.get("k8s");
    const browser = new Browser(k8s);
    const links = declareLinks(ctx.settings);

    ctx.scheduler.every("workloads.idle-watches", 60_000, () => browser.cache.sweep());

    ctx.route("GET /api/workloads/links", () => links());
    ctx.route("GET /api/workloads/namespaces", () => browser.namespaces());
    ctx.route("GET /api/workloads/namespaces/:namespace/workloads", (req) => browser.workloads(req.params.namespace));
    ctx.route("GET /api/workloads/namespaces/:namespace/pods", (req) =>
      browser.pods(req.params.namespace, req.query.workload || undefined)
    );
    ctx.route("GET /api/workloads/namespaces/:namespace/pods/:pod", (req) =>
      browser.pod(req.params.namespace, req.params.pod)
    );
    ctx.route("GET /api/workloads/namespaces/:namespace/events", (req) =>
      browser.events(req.params.namespace, req.query.object || undefined)
    );
    ctx.route("GET /api/workloads/namespaces/:namespace/pods/:pod/logs", (req) =>
      readLogs(k8s(), browser, req.params.namespace, req.params.pod, req.query)
    );
    ctx.route("GET /api/workloads/namespaces/:namespace/pods/:pod/logs/stream", async (req, res) => {
      await followLogs(k8s(), browser, req.params.namespace, req.params.pod, req.query, res);
      return undefined;
    });
  },
};

export default mod;

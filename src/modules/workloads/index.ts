import type { Module } from "../../contracts/module.js";
import { Browser } from "./browser.js";
import { declareLinks } from "./links.js";
import { followLogs, readLogs } from "./logs.js";
import { migrations } from "./migrations.js";
import { clusterUsage, parseRange, spaceUsage } from "./usage.js";

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
    // Without the metrics module there is nothing to summarise, but requests
    // and limits still are.
    const usageInputs = async (range: unknown) => ({
      ...(await browser.usageInputs()),
      metrics: ctx.services.has("metrics") ? ctx.services.get("metrics") : undefined,
      range: parseRange(range),
      now: Date.now(),
    });
    ctx.route("GET /api/workloads/usage", async (req) => clusterUsage(await usageInputs(req.query.range)));
    ctx.route("GET /api/workloads/namespaces/:namespace/usage", async (req) => {
      await browser.namespace(req.params.namespace);
      return spaceUsage(req.params.namespace, await usageInputs(req.query.range));
    });
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

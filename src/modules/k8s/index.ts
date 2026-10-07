import { z } from "zod";
import type { Module } from "../../contracts/module.js";
import { createK8sService } from "./api.js";
import { connectionHealthProvider } from "./health.js";
import { migrations } from "./migrations.js";
import { resolveConnection, type Connection } from "./transport.js";

const mod: Module = {
  id: "k8s",
  milestone: "A",
  migrations,
  register(ctx) {
    const kubeconfig = ctx.settings.declare({
      key: "k8s.kubeconfig",
      label: "Kubeconfig file",
      help: "Path to a kubeconfig. Empty: the pod's ServiceAccount in a cluster, else ~/.kube/config.",
      schema: z.string(),
      default: "",
      env: "KUBECONFIG",
      envOnly: true,
    });
    const context = ctx.settings.declare({
      key: "k8s.context",
      label: "Kubeconfig context",
      help: "Context to use from the kubeconfig. Empty: its current context.",
      schema: z.string(),
      default: "",
      env: "KUBE_CONTEXT",
      envOnly: true,
    });

    // Re-resolved only when a setting changes, so the KubeConfig (and the
    // agent client-node caches on it) survives between calls.
    let resolved: { key: string; conn: Connection } | undefined;
    const connection = (): Connection => {
      const file = kubeconfig.get();
      const ctxName = context.get();
      const key = JSON.stringify([file, ctxName]);
      if (resolved?.key !== key) {
        let conn: Connection;
        try {
          conn = resolveConnection({ kubeconfig: file || undefined, context: ctxName || undefined });
        } catch (err) {
          ctx.log.error("Kubernetes connection could not be loaded", { error: String(err) });
          conn = { source: "none" };
        }
        if (resolved) ctx.log.info("Kubernetes connection changed", { source: conn.source, server: conn.server });
        resolved = { key, conn };
      }
      return resolved.conn;
    };

    const k8s = createK8sService({ connection });
    const conn = connection();
    if (conn.source === "none") ctx.log.warn("No Kubernetes connection: not in a cluster and no kubeconfig found");
    else ctx.log.info("Kubernetes connection", { source: conn.source, server: conn.server, context: conn.context });

    ctx.services.provide("k8s", k8s);
    ctx.health.addProvider(connectionHealthProvider(k8s));

    ctx.scheduler.every("k8s.capabilities", 10 * 60_000, () => k8s.capabilities(true), { runImmediately: true });

    ctx.route("GET /api/k8s/capabilities", (req) => k8s.capabilities(req.query.refresh === "1"));
  },
};

export default mod;

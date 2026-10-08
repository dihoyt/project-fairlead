import { z } from "zod";
import type { Module } from "../../contracts/module.js";
import { HttpError } from "../../runtime/http.js";
import { createJoin, createRateLimit, podNamespace } from "./join.js";
import { createLinker } from "./links.js";
import { migrations } from "./migrations.js";
import { clusterHealthProvider } from "./provider.js";
import { declareSettings } from "./settings.js";

const linkRequest = z.object({
  role: z.enum(["agent", "server"]).default("agent"),
  baseUrl: z
    .string()
    .url()
    .refine((value) => /^https?:$/.test(new URL(value).protocol), "must be http or https"),
});

const NOT_FOUND = "This join link doesn't exist, has expired or was already used. Make a new one in the UI.";

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

    const join = createJoin({
      db: ctx.db,
      orgId: ctx.orgId,
      k8s: () => ctx.services.get("k8s"),
      namespace: podNamespace,
    });
    const allow = createRateLimit(30, 60_000);

    ctx.route("GET /api/cluster/join", () => join.status());

    ctx.route("POST /api/cluster/join-links", async (req, res) => {
      const user = ctx.require(req, res, "write");
      if (!user) return undefined;
      const parsed = linkRequest.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new HttpError(
          400,
          parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")
        );
      }
      const link = await join.create({ ...parsed.data, actor: user.id });
      ctx.audit.record({
        actor: user.id,
        action: "cluster.join-link.create",
        target: link.id,
        detail: `role ${link.role}`,
      });
      return link;
    });

    ctx.route("DELETE /api/cluster/join-links/:id", (req, res) => {
      const user = ctx.require(req, res, "write");
      if (!user) return undefined;
      if (!join.revoke(req.params.id)) throw new HttpError(404, "No unused join link with that id.");
      ctx.audit.record({ actor: user.id, action: "cluster.join-link.revoke", target: req.params.id });
      return { ok: true };
    });

    ctx.publicRoute("GET /join/:token", async (req, res) => {
      res.set("Cache-Control", "no-store");
      if (!allow()) throw new HttpError(429, "Too many join requests; try again in a minute.");
      const found = await join.script(req.params.token);
      if (!found) throw new HttpError(404, NOT_FOUND);
      ctx.audit.record({
        actor: "system",
        action: "cluster.join-link.use",
        target: found.id,
        detail: `role ${found.role}`,
      });
      ctx.log.info("Join link used", { id: found.id, role: found.role });
      res.type("text/x-shellscript").send(found.script);
      return undefined;
    });
  },
};

export default mod;

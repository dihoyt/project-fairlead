import { CATEGORIES } from "../../contracts/health.js";
import type { Category } from "../../contracts/health.js";
import type { Module } from "../../contracts/module.js";
import { HttpError } from "../../runtime/http.js";
import { createLinkStore } from "./links.js";
import { migrations } from "./migrations.js";
import { startHealth } from "./service.js";

function isoParam(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, `${name} must be an ISO 8601 timestamp.`);
  }
  return new Date(value).toISOString();
}

const mod: Module = {
  id: "health",
  milestone: "A",
  migrations,
  register(ctx) {
    const health = startHealth(ctx);
    const links = createLinkStore(ctx.db, ctx.orgId, health.settings.links);
    ctx.reset.add({ scope: "links", clear: () => links.clear() });

    ctx.route("GET /api/health/board", () => health.board());

    ctx.route("GET /api/health/categories/:category", (req) => {
      const category = req.params.category;
      if (!CATEGORIES.includes(category as Category)) throw new HttpError(404, `No category "${category}".`);
      return {
        ...health.category(category),
        links: links.list(category).map(({ label, url }) => ({ label, url })),
      };
    });

    ctx.route("GET /api/health/links", (req) => {
      const { category } = req.query;
      if (category !== undefined && !CATEGORIES.includes(category))
        throw new HttpError(400, `No category "${category}".`);
      return links.list(category);
    });

    ctx.route("POST /api/health/links", (req, res) => {
      const user = ctx.require(req, res, "write");
      if (!user) return undefined;
      const link = links.create(req.body, user.id);
      ctx.audit.record({
        actor: user.id,
        action: "health.link-create",
        target: link.id,
        detail: `${link.label} ${link.url}`,
      });
      return link;
    });

    ctx.route("PUT /api/health/links/:id", (req, res) => {
      const user = ctx.require(req, res, "write");
      if (!user) return undefined;
      const link = links.update(req.params.id, req.body);
      ctx.audit.record({
        actor: user.id,
        action: "health.link-update",
        target: link.id,
        detail: `${link.label} ${link.url}`,
      });
      return link;
    });

    ctx.route("DELETE /api/health/links/:id", (req, res) => {
      const user = ctx.require(req, res, "write");
      if (!user) return undefined;
      const link = links.remove(req.params.id);
      ctx.audit.record({ actor: user.id, action: "health.link-delete", target: link.id, detail: link.label });
      return { ok: true };
    });

    ctx.route("GET /api/health/history/:providerId/:checkId", (req) => {
      const from = isoParam(req.query.from, "from");
      const to = isoParam(req.query.to, "to");
      if (from && to && from > to) throw new HttpError(400, "from must not be after to.");
      return health.history(req.params.providerId, req.params.checkId, from, to);
    });

    ctx.route("POST /api/health/providers/:providerId/run", async (req, res) => {
      const user = ctx.require(req, res, "write");
      if (!user) return undefined;
      const { providerId } = req.params;
      const results = await health.run(providerId, { force: true });
      if (!results) throw new HttpError(404, `No health provider "${providerId}".`);
      ctx.audit.record({ actor: user.id, action: "health.run", target: providerId });
      return results;
    });
  },
};

export default mod;

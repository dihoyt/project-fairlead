import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import { MCP_TOOLS, type McpToolName } from "../../contracts/mcp.js";
import type { Module, ModuleContext } from "../../contracts/module.js";
import type { User } from "../../contracts/platform.js";
import { HttpError } from "../../runtime/http.js";
import { errorMessage } from "../../runtime/log.js";
import { product } from "../../product.js";
import { createRateLimiter } from "./limiter.js";
import { TOOLS, type Caller } from "./tools.js";

const VERSION = process.env.GIT_SHA || "dev";

// The tools a token's scope allows; a read token never sees the write ones.
export function toolsFor(user: User): typeof MCP_TOOLS {
  return MCP_TOOLS.filter((spec) => spec.scope === "read" || user.token?.scope === "write");
}

// One server per request: the endpoint is stateless, so nothing about a
// client outlives its request, and each request's tools call as its caller.
function buildServer(ctx: ModuleContext, req: Request, user: User): McpServer {
  const server = new McpServer({ name: product.slug, title: product.displayName, version: VERSION });
  const call: Caller = (key, input) => ctx.call(req, key, input);

  for (const spec of toolsFor(user)) {
    const def = TOOLS[spec.name] as (typeof TOOLS)[McpToolName];
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: def.input,
        annotations: {
          title: spec.title,
          readOnlyHint: spec.readOnly,
          destructiveHint: spec.destructive,
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        const started = Date.now();
        try {
          const result = (await def.run(call, args as never)) as Record<string, unknown>;
          // Arguments are never logged: they can hold check secrets and deploy passwords.
          ctx.log.info("MCP tool call", {
            tool: spec.name,
            user: user.id,
            token: user.token?.id,
            ms: Date.now() - started,
          });
          return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
        } catch (err) {
          const message = err instanceof HttpError ? err.message : errorMessage(err);
          ctx.log.info("MCP tool call failed", {
            tool: spec.name,
            user: user.id,
            token: user.token?.id,
            status: err instanceof HttpError ? err.status : 500,
            ms: Date.now() - started,
          });
          return { isError: true, content: [{ type: "text", text: message }] };
        }
      }
    );
  }
  return server;
}

function notAllowed(_req: Request, res: Response): undefined {
  res.setHeader("Allow", "POST");
  res.status(405).json({ error: "Method not allowed." });
  return undefined;
}

const mod: Module = {
  id: "mcp",
  milestone: "A",
  register(ctx) {
    const perMinute = ctx.settings.declare({
      key: "mcp.requestsPerMinute",
      label: "MCP requests per minute",
      help: "Per API token. Requests over the limit are answered 429 until the minute is up.",
      schema: z.coerce.number().int().min(1).max(10000),
      default: 120,
      env: "MCP_REQUESTS_PER_MINUTE",
    });
    const limiter = createRateLimiter(60_000);

    ctx.route("POST /api/mcp", async (req, res) => {
      const user = ctx.identify(req);
      if (user.source !== "token" || !user.token) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="mcp"');
        res.status(401).json({ error: "The MCP endpoint takes an API token: Authorization: Bearer <token>." });
        return undefined;
      }
      const wait = limiter.take(user.token.id, perMinute.get());
      if (wait > 0) {
        res.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
        res.status(429).json({ error: "Too many MCP requests for this token; try again shortly." });
        return undefined;
      }

      const server = buildServer(ctx, req, user);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req as Request & { auth?: never }, res as Response, req.body);
      return undefined;
    });

    ctx.route("GET /api/mcp", notAllowed);
    ctx.route("DELETE /api/mcp", notAllowed);
  },
};

export default mod;

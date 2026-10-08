import express, { type Request, type Response, type Router } from "express";
import { OAUTH_SCOPES, type OAuthAuthorizeParams } from "../../contracts/auth.js";
import { MCP_PATH } from "../../contracts/mcp.js";
import { FailureLimiter } from "../auth/limiter.js";
import {
  OAuthError,
  checkAuthorizeRequest,
  exchangeCode,
  redirectUriProblem,
  redirectWith,
  refreshGrant,
  registerClient,
} from "../auth/oauth.js";
import { effectivePublicUrl, type Core } from "../core.js";
import { clientIp } from "../net.js";

// The OAuth endpoints MCP clients find through the metadata below. None of
// them uses the session cookie, so they are mounted ahead of the origin
// guard and answer cross-origin requests (browser-based MCP clients).

const REGISTRATIONS_PER_HOUR = 20;

export function oauthBase(core: Core, req: Request): string {
  return effectivePublicUrl(core, req).value.replace(/\/+$/, "");
}

export const mcpResource = (base: string): string => `${base}${MCP_PATH}`;

// The header a 401 from /mcp carries, so a client can find how to sign in.
export function mcpChallenge(core: Core, req: Request): string {
  return `Bearer realm="mcp", resource_metadata="${oauthBase(core, req)}/.well-known/oauth-protected-resource${MCP_PATH}"`;
}

function cors(req: Request, res: Response, next: () => void): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, mcp-protocol-version");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

function oauthJsonError(res: Response, err: unknown): void {
  if (err instanceof OAuthError) {
    res.status(err.status).json({ error: err.code, error_description: err.message });
    return;
  }
  throw err;
}

export function oauthRouter(core: Core): Router {
  const router = express.Router();
  const registrations = new FailureLimiter(REGISTRATIONS_PER_HOUR, 60 * 60 * 1000);

  router.use(["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", "/oauth"], cors);

  const protectedResource = (req: Request, res: Response) => {
    const base = oauthBase(core, req);
    res.json({
      resource: mcpResource(base),
      authorization_servers: [base],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ["header"],
    });
  };
  router.get("/.well-known/oauth-protected-resource", protectedResource);
  router.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, protectedResource);

  router.get("/.well-known/oauth-authorization-server", (req, res) => {
    const base = oauthBase(core, req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: OAUTH_SCOPES,
    });
  });

  router.post("/oauth/register", (req, res) => {
    const ip = clientIp(req);
    if (registrations.isBlocked(ip)) {
      res.setHeader("Retry-After", String(registrations.retryAfterSeconds(ip)));
      res.status(429).json({ error: "temporarily_unavailable", error_description: "Too many registrations." });
      return;
    }
    registrations.fail(ip);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    const problem = uris.length === 0 ? "redirect_uris is required." : uris.map(redirectUriProblem).find(Boolean);
    if (problem) {
      res.status(400).json({ error: "invalid_redirect_uri", error_description: problem });
      return;
    }
    const auth = body.token_endpoint_auth_method;
    if (auth !== undefined && auth !== "none") {
      res.status(400).json({
        error: "invalid_client_metadata",
        error_description: "Only public clients (token_endpoint_auth_method none) are supported.",
      });
      return;
    }
    const rawName = typeof body.client_name === "string" ? body.client_name.trim() : "";
    try {
      const client = registerClient(core, {
        name: rawName.slice(0, 80) || "MCP client",
        redirectUris: uris as string[],
      });
      core.audit.record({
        actor: "system",
        ip,
        action: "oauth.register",
        target: client.clientId,
        detail: client.name,
      });
      res.status(201).json({
        client_id: client.clientId,
        client_id_issued_at: Math.floor(client.createdAt / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    } catch (err) {
      oauthJsonError(res, err);
    }
  });

  // A browser navigation. A request that names an unknown client or
  // redirect URI is answered here; anything else goes to the consent page,
  // which checks it again before asking anyone.
  router.get("/oauth/authorize", (req, res) => {
    const params = req.query as Partial<Record<keyof OAuthAuthorizeParams, string>>;
    try {
      checkAuthorizeRequest(core, params, mcpResource(oauthBase(core, req)));
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      if (err.code === "invalid_client" || err.code === "invalid_redirect_uri") {
        res.status(400).type("text/plain").send(`${err.message}\n`);
        return;
      }
      res.redirect(
        302,
        redirectWith(params.redirect_uri!, { error: err.code, error_description: err.message, state: params.state })
      );
      return;
    }
    const query = new URLSearchParams(params as Record<string, string>).toString();
    // Relative, so it lands on the console wherever it is served from.
    res.redirect(302, `../#/oauth/consent?${query}`);
  });

  router.post("/oauth/token", express.urlencoded({ extended: false }), (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : "");
    try {
      if (body.grant_type === "authorization_code") {
        const { tokens, grant } = exchangeCode(core, {
          code: text("code"),
          clientId: text("client_id"),
          redirectUri: text("redirect_uri"),
          codeVerifier: text("code_verifier"),
        });
        core.audit.record({
          actor: "system",
          ip: clientIp(req),
          action: "oauth.token",
          target: grant.id,
          detail: `${grant.name} (${grant.scope})`,
        });
        res.json(tokens);
        return;
      }
      if (body.grant_type === "refresh_token") {
        res.json(refreshGrant(core, { refreshToken: text("refresh_token"), clientId: text("client_id") }));
        return;
      }
      throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
    } catch (err) {
      oauthJsonError(res, err);
    }
  });

  return router;
}

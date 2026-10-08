import type { NextFunction, Request, RequestHandler, Response } from "express";
import { publicOrigin, requestOrigin, type Core } from "./core.js";

// Cross-site request forgery defence for every state-changing request.
//
// The session cookie is SameSite=Lax, which stops a cross-*site* form post
// but not a cross-*origin* one from a sibling subdomain: anything else served
// under the same registrable domain counts as the same site. So a mutation
// must also come from this install's own pages. Browsers state where a
// request came from in Sec-Fetch-Site (and Origin); a request carrying
// neither is not from a browser page, and therefore carries no cookie a page
// could have borrowed.

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

// The configured public URL, and also the address the request itself was
// sent to: a page on another origin cannot make its Origin header equal the
// Host it is posting to, and an install reached by a second address (a
// NodePort beside the ingress) keeps working whatever the public URL says.
function sameOrigin(core: Core, req: Request, origin: string): boolean {
  const configured = publicOrigin(core);
  if (configured && origin === new URL(configured).origin) return true;
  return origin === requestOrigin(req);
}

export function originGuard(core: Core): RequestHandler {
  return (req, res, next) => check(core, req, res, next);
}

function check(core: Core, req: Request, res: Response, next: NextFunction): void {
  if (SAFE.has(req.method)) {
    next();
    return;
  }
  const site = req.get("sec-fetch-site");
  const origin = req.get("origin");
  if (site === undefined && origin === undefined) {
    next();
    return;
  }
  if (site === "same-origin" || (origin !== undefined && sameOrigin(core, req, origin))) {
    next();
    return;
  }
  res.status(403).json({ error: "Request refused: it did not come from this install's own pages." });
}

import type { NextFunction, Request, Response } from "express";
import { publicOrigin } from "./core.js";

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

function expectedOrigin(req: Request): string {
  const configured = publicOrigin();
  if (configured) return new URL(configured).origin;
  // Unconfigured (local development): compare against the host the browser
  // addressed, which is all there is to go on.
  return `${req.protocol}://${req.get("host") ?? ""}`;
}

export function originGuard(req: Request, res: Response, next: NextFunction): void {
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
  if (site === "same-origin" || (origin !== undefined && origin === expectedOrigin(req))) {
    next();
    return;
  }
  res.status(403).json({ error: "Request refused: it did not come from this install's own pages." });
}

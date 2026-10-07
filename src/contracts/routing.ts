import type { Request, Response } from "express";
import type { ApiRoutes, RouteKey } from "./api.js";

export type TypedRequest<K extends RouteKey> = Request<
  ApiRoutes[K]["params"],
  unknown,
  // Untrusted until validated: the contract says what a well-formed body is,
  // not what a caller sent.
  Partial<ApiRoutes[K]["body"]> | undefined,
  Partial<ApiRoutes[K]["query"]>
>;

// Return the response body to have it sent as JSON with 200, or write to
// `res` yourself (streams, CSV, non-200) and return undefined. Throw
// HttpError (src/runtime/http.ts) for an error response.
export type RouteHandler<K extends RouteKey> = (
  req: TypedRequest<K>,
  res: Response
) => ApiRoutes[K]["response"] | undefined | Promise<ApiRoutes[K]["response"] | undefined>;

// Creates, or finds again, the OIDC client this install signs in through,
// using Pocket ID's REST API with an admin's API key. Nothing here logs or
// returns the key or the client secret.
//
// Written against Pocket ID 2.16 (what the catalog's chart runs), X-API-Key
// auth. Paths relied on:
//   GET  /api/oidc/clients/{id}             404 when absent
//   POST /api/oidc/clients                  { id, name, callbackURLs, launchURL, pkceEnabled, ... }
//   PUT  /api/oidc/clients/{id}             the whole client; credentials are ignored
//   POST /api/oidc/clients/{id}/secrets     {} -> { id, secret }, the only time the value is shown
// A client may hold several secrets. Newer releases can make one with the
// client and return it as createdSecret; it is used instead of adding a
// second.

import { apiUrlProblem } from "./authentik.js";

const TIMEOUT_MS = 15_000;

export class PocketIdError extends Error {}

export interface PocketIdTarget {
  // Where the API is called.
  apiUrl: string;
  // Pocket ID as browsers reach it (its APP_URL), which is its issuer.
  publicUrl: string;
  apiKey: string;
  clientId: string;
  name: string;
  redirectUri: string;
  launchUrl: string;
}

export interface PocketIdOutcome {
  issuer: string;
  clientId: string;
  clientSecret: string;
  client: "created" | "updated" | "unchanged";
}

interface Client {
  id: string;
  name: string;
  callbackURLs?: string[] | null;
  createdSecret?: { secret?: string } | null;
  [field: string]: unknown;
}

// Pocket ID's issuer is its APP_URL, which it keeps without a trailing slash.
export const pocketIdIssuer = (baseUrl: string): string => baseUrl.replace(/\/+$/, "");

export const pocketIdUrlProblem = (raw: string, use: "public" | "api"): string | null =>
  apiUrlProblem(raw, use, "Pocket ID");

export function pocketIdClient(baseUrl: string, apiKey: string) {
  const host = new URL(baseUrl).host;
  return async <T>(method: string, path: string, body?: unknown): Promise<T | null> => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api${path}`, {
        method,
        headers: {
          "x-api-key": apiKey,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new PocketIdError(`Could not reach Pocket ID at ${host}: ${(err as Error).message}`);
    }
    if (method === "GET" && response.status === 404) return null;
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new PocketIdError(
        `Pocket ID refused the API key (${response.status}). Use an API key made by an admin under Settings > Admin > API Keys.`
      );
    }
    if (!response.ok) {
      throw new PocketIdError(`Pocket ID answered ${response.status} to ${method} ${path}: ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PocketIdError(`Pocket ID answered ${method} ${path} with something that is not JSON.`);
    }
  };
}

export async function wirePocketId(target: PocketIdTarget): Promise<PocketIdOutcome> {
  const call = pocketIdClient(target.apiUrl, target.apiKey);
  const path = `/oidc/clients/${encodeURIComponent(target.clientId)}`;
  let client = await call<Client>("GET", path);

  let state: PocketIdOutcome["client"] = "unchanged";
  if (client === null) {
    client = await call<Client>("POST", "/oidc/clients", {
      id: target.clientId,
      name: target.name,
      callbackURLs: [target.redirectUri],
      logoutCallbackURLs: [],
      launchURL: target.launchUrl,
      isPublic: false,
      pkceEnabled: true,
      credentials: {},
    });
    if (client === null) throw new PocketIdError("Pocket ID did not return the client it created.");
    state = "created";
  } else if (!(client.callbackURLs ?? []).includes(target.redirectUri)) {
    const { createdSecret: _ignored, ...current } = client;
    client =
      (await call<Client>("PUT", path, {
        ...current,
        callbackURLs: [...(client.callbackURLs ?? []), target.redirectUri],
      })) ?? client;
    state = "updated";
  }

  let secret = state === "created" ? (client.createdSecret?.secret ?? "") : "";
  if (!secret) secret = (await call<{ secret?: string }>("POST", `${path}/secrets`, {}))?.secret ?? "";
  if (!secret) {
    throw new PocketIdError("Pocket ID did not return a client secret; the API key may lack rights to make one.");
  }
  return { issuer: pocketIdIssuer(target.publicUrl), clientId: client.id, clientSecret: secret, client: state };
}

// Microsoft Graph, as much of it as the connector uses, with app-only
// (client credentials) tokens for the management app registration, which
// signs in with a certificate (client assertion) or a client secret.
//
// Paths relied on (Graph v1.0):
//   POST {login}/{tenant}/oauth2/v2.0/token          client_credentials, scope {graph}/.default
//   GET  /applications(appId='{appId}')              the management app itself; 403/404 unless it
//                                                    may read it (Application.ReadWrite.All, or it
//                                                    owns itself)
//   POST /applications/{id}/addKey                   { keyCredential, passwordCredential: null, proof };
//                                                    no permission needed for an app's own keys
//   POST /applications/{id}/removeKey                { keyId, proof }; 204
//   POST /applications                               the caller becomes an owner (OwnedBy)
//   GET  /applications/{objectId}                    404 once deleted; 403/404 when not owned
//   PATCH /applications/{objectId}                   204
//   DELETE /applications/{objectId}                  204
//   POST /applications/{objectId}/addPassword        { keyId, secretText, endDateTime }
//   POST /applications/{objectId}/removePassword     204
//   GET  /groups?$filter=…&$top=&$select=            needs Group.Read.All (or Directory.Read.All)
//   POST /users/{address}/sendMail                    202; needs Mail.Send for that mailbox (Exchange
//                                                    RBAC for Applications, or the Graph permission)
// {id} is an object id or appId='…'. PATCH keyCredentials replaces the whole
// list; Graph never returns a certificate's key, so only a caller holding
// every certificate it wants kept can PATCH it.
// Nothing here logs or returns the management secret, a private key or a
// created client secret except addPassword's result to its caller.

import crypto from "node:crypto";
import { signJwt } from "./x509.js";

const TIMEOUT_MS = 15_000;
// Tokens are reused until shortly before they expire.
const TOKEN_MARGIN_MS = 60_000;

export const LOGIN_BASE = "https://login.microsoftonline.com";
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export interface GraphEndpoints {
  login: string;
  graph: string;
}

export type GraphCredential =
  | { kind: "secret"; clientSecret: string }
  | { kind: "certificate"; privateKey: string; certificate: string; thumbprint: string };

export interface GraphCredentials {
  tenantId: string;
  clientId: string;
  credential: GraphCredential;
}

// The audience of a key proof for addKey/removeKey: the AAD Graph app id.
const PROOF_AUDIENCE = "00000002-0000-0000-c000-000000000000";
const JWT_TTL_S = 600;

export class GraphError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface GraphApplication {
  id: string;
  appId: string;
  displayName: string;
  tags?: string[];
  groupMembershipClaims?: string | null;
  web?: { redirectUris?: string[] };
  passwordCredentials?: Array<{
    keyId: string;
    displayName?: string | null;
    endDateTime?: string | null;
    // The secret's first three characters.
    hint?: string | null;
  }>;
  keyCredentials?: GraphKeyCredential[];
}

export interface GraphKeyCredential {
  keyId: string;
  displayName?: string | null;
  endDateTime?: string | null;
  type?: string;
  // base64 of the certificate's SHA-1 thumbprint.
  customKeyIdentifier?: string | null;
}

// A certificate as keyCredentials takes it on PATCH or addKey.
export interface NewKeyCredential {
  // base64 DER.
  key: string;
  displayName: string;
}

export const keyCredentialBody = (cert: NewKeyCredential) => ({
  type: "AsymmetricX509Cert",
  usage: "Verify",
  key: cert.key,
  displayName: cert.displayName,
});

// Whether Graph's keyCredential is this certificate: by display name (which
// carries the thumbprint) or by customKeyIdentifier, which Entra fills in
// with the thumbprint.
export function isCertificate(credential: GraphKeyCredential, thumbprint: string): boolean {
  if (credential.displayName?.includes(thumbprint)) return true;
  const id = credential.customKeyIdentifier ?? "";
  return (
    id !== "" &&
    (Buffer.from(id, "base64").toString("hex").toUpperCase() === thumbprint ||
      Buffer.from(id, "base64").toString("utf8").toUpperCase() === thumbprint)
  );
}

// A proof of possession for addKey/removeKey on application `objectId`,
// signed with one of its current certificates.
export function keyProof(
  key: { privateKey: string; certificate: string },
  objectId: string,
  nowMs = Date.now()
): string {
  const now = Math.floor(nowMs / 1000);
  return signJwt(key, { aud: PROOF_AUDIENCE, iss: objectId, nbf: now, exp: now + JWT_TTL_S, jti: crypto.randomUUID() });
}

export interface GraphPassword {
  keyId: string;
  secretText: string;
  endDateTime: string;
}

// Tenant ids are GUIDs or verified domain names.
const TENANT = /^[A-Za-z0-9.-]+$/;

export function tenantProblem(tenantId: string): string | null {
  return TENANT.test(tenantId) ? null : "The tenant ID must be a GUID or a domain name.";
}

export function issuerFor(tenantId: string, endpoints: GraphEndpoints): string {
  return `${endpoints.login}/${tenantId}/v2.0`;
}

export function consentUrlFor(tenantId: string, clientId: string, endpoints: GraphEndpoints): string {
  return `${endpoints.login}/${encodeURIComponent(tenantId)}/adminconsent?client_id=${encodeURIComponent(clientId)}`;
}

// The roles claim of an app-only token: the application permissions granted.
export function tokenRoles(token: string): string[] {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      roles?: unknown;
    };
    return Array.isArray(payload.roles) ? payload.roles.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

async function errorOf(res: Response, what: string): Promise<GraphError> {
  const text = await res.text().catch(() => "");
  let code = "";
  let message = "";
  try {
    const body = JSON.parse(text) as {
      error?: string | { code?: string; message?: string };
      error_description?: string;
    };
    if (typeof body.error === "string") {
      code = body.error;
      // AADSTS messages carry a trace and timestamp on later lines.
      message = (body.error_description ?? "").split(/\r?\n/)[0] ?? "";
    } else if (body.error) {
      code = body.error.code ?? "";
      message = body.error.message ?? "";
    }
  } catch {
    // Not JSON: the status says enough.
  }
  return new GraphError(
    res.status,
    code,
    `${what} answered ${res.status}${message ? `: ${message}` : code ? ` (${code})` : ""}`
  );
}

export interface GraphClient {
  // Fetches (or reuses, unless fresh) an app-only token; throws GraphError
  // when refused. A fresh one carries permissions consented since.
  token(signal?: AbortSignal, fresh?: boolean): Promise<string>;
  // The management app itself, by its client id; undefined when Graph
  // refuses (403) or hides it (404) from this caller.
  self(signal?: AbortSignal): Promise<GraphApplication | undefined>;
  // `app`: an object id, or appId='…' for the caller itself.
  addKey(app: string, cert: NewKeyCredential, proof: string, signal?: AbortSignal): Promise<GraphKeyCredential>;
  removeKey(app: string, keyId: string, proof: string, signal?: AbortSignal): Promise<void>;
  createApplication(body: Record<string, unknown>, signal?: AbortSignal): Promise<GraphApplication>;
  // undefined when Graph says 404 (deleted, or not visible to an OwnedBy caller).
  getApplication(objectId: string, signal?: AbortSignal): Promise<GraphApplication | undefined>;
  updateApplication(objectId: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
  deleteApplication(objectId: string, signal?: AbortSignal): Promise<void>;
  addPassword(objectId: string, displayName: string, endDateTime: string, signal?: AbortSignal): Promise<GraphPassword>;
  removePassword(objectId: string, keyId: string, signal?: AbortSignal): Promise<void>;
  groups(search: string, signal?: AbortSignal): Promise<Array<{ id: string; displayName: string }>>;
  sendMail(from: string, message: GraphMail, signal?: AbortSignal): Promise<void>;
}

export interface GraphMail {
  to: string[];
  subject: string;
  html: string;
}

const withTimeout = (signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);

// An object id, or "appId='…'" (already in Graph's alternate-key form).
const appPath = (objectId: string) =>
  objectId.startsWith("appId=") ? `/applications(${objectId})` : `/applications/${encodeURIComponent(objectId)}`;

export const selfRef = (clientId: string) => `appId='${clientId.replace(/'/g, "''")}'`;

const tokens = new Map<string, { value: string; expires: number }>();

function credentialForm(creds: GraphCredentials, tokenUrl: string): Record<string, string> {
  const c = creds.credential;
  if (c.kind === "secret") return { client_secret: c.clientSecret };
  const now = Math.floor(Date.now() / 1000);
  return {
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: signJwt(c, {
      aud: tokenUrl,
      iss: creds.clientId,
      sub: creds.clientId,
      jti: crypto.randomUUID(),
      iat: now,
      nbf: now,
      exp: now + JWT_TTL_S,
    }),
  };
}

export function createGraphClient(creds: GraphCredentials, endpoints: GraphEndpoints): GraphClient {
  const c = creds.credential;
  const credentialKey = c.kind === "secret" ? `s:${c.clientSecret}` : `c:${c.thumbprint}`;
  const cacheKey = `${endpoints.login}|${creds.tenantId}|${creds.clientId}|${credentialKey}`;

  async function token(signal?: AbortSignal, fresh = false): Promise<string> {
    const cached = tokens.get(cacheKey);
    if (!fresh && cached && cached.expires > Date.now() + TOKEN_MARGIN_MS) return cached.value;
    const problem = tenantProblem(creds.tenantId);
    if (problem) throw new GraphError(400, "invalid_tenant", problem);
    const tokenUrl = `${endpoints.login}/${encodeURIComponent(creds.tenantId)}/oauth2/v2.0/token`;
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: creds.clientId,
        ...credentialForm(creds, tokenUrl),
        scope: `${new URL(endpoints.graph).origin}/.default`,
      }),
      signal: withTimeout(signal),
    });
    if (!res.ok) throw await errorOf(res, "Sign-in for the management app");
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new GraphError(502, "no_token", "Sign-in for the management app returned no token");
    tokens.set(cacheKey, { value: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 });
    return body.access_token;
  }

  async function call(method: string, path: string, what: string, body?: unknown, signal?: AbortSignal) {
    const res = await fetch(`${endpoints.graph}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await token(signal)}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: withTimeout(signal),
    });
    if (!res.ok) {
      // A revoked or rotated management secret: the next call signs in again.
      if (res.status === 401) tokens.delete(cacheKey);
      throw await errorOf(res, what);
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as unknown) : undefined;
  }

  return {
    token,
    async self(signal) {
      try {
        return (await call(
          "GET",
          appPath(selfRef(creds.clientId)),
          "Reading the management app",
          undefined,
          signal
        )) as GraphApplication;
      } catch (err) {
        if (err instanceof GraphError && (err.status === 403 || err.status === 404)) return undefined;
        throw err;
      }
    },
    async addKey(app, cert, proof, signal) {
      return (await call(
        "POST",
        `${appPath(app)}/addKey`,
        "Adding a certificate",
        { keyCredential: keyCredentialBody(cert), passwordCredential: null, proof },
        signal
      )) as GraphKeyCredential;
    },
    async removeKey(app, keyId, proof, signal) {
      await call("POST", `${appPath(app)}/removeKey`, "Removing an old certificate", { keyId, proof }, signal);
    },
    async createApplication(body, signal) {
      return (await call("POST", "/applications", "Creating the app registration", body, signal)) as GraphApplication;
    },
    async getApplication(objectId, signal) {
      try {
        return (await call(
          "GET",
          appPath(objectId),
          "Reading the app registration",
          undefined,
          signal
        )) as GraphApplication;
      } catch (err) {
        if (err instanceof GraphError && err.status === 404) return undefined;
        throw err;
      }
    },
    async updateApplication(objectId, body, signal) {
      await call("PATCH", appPath(objectId), "Updating the app registration", body, signal);
    },
    async deleteApplication(objectId, signal) {
      try {
        await call("DELETE", appPath(objectId), "Deleting the app registration", undefined, signal);
      } catch (err) {
        if (!(err instanceof GraphError && err.status === 404)) throw err;
      }
    },
    async addPassword(objectId, displayName, endDateTime, signal) {
      return (await call(
        "POST",
        `${appPath(objectId)}/addPassword`,
        "Creating a client secret",
        { passwordCredential: { displayName, endDateTime } },
        signal
      )) as GraphPassword;
    },
    async removePassword(objectId, keyId, signal) {
      await call("POST", `${appPath(objectId)}/removePassword`, "Removing an old client secret", { keyId }, signal);
    },
    async groups(search, signal) {
      const filters = ["securityEnabled eq true"];
      const prefix = search.trim();
      if (prefix) filters.push(`startswith(displayName,'${prefix.replace(/'/g, "''")}')`);
      const query = new URLSearchParams({
        $filter: filters.join(" and "),
        $top: "50",
        $select: "id,displayName",
      });
      const body = (await call("GET", `/groups?${query}`, "Listing groups", undefined, signal)) as {
        value?: Array<{ id: string; displayName: string }>;
      };
      return (body.value ?? []).map((g) => ({ id: g.id, displayName: g.displayName }));
    },
    async sendMail(from, message, signal) {
      await call(
        "POST",
        `/users/${encodeURIComponent(from)}/sendMail`,
        "Sending mail",
        {
          message: {
            subject: message.subject,
            body: { contentType: "HTML", content: message.html },
            toRecipients: message.to.map((address) => ({ emailAddress: { address } })),
          },
          saveToSentItems: false,
        },
        signal
      );
    },
  };
}

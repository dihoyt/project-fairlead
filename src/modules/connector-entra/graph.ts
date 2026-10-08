// Microsoft Graph, as much of it as the connector uses, with app-only
// (client credentials) tokens for the management app registration.
//
// Paths relied on (Graph v1.0):
//   POST {login}/{tenant}/oauth2/v2.0/token          client_credentials, scope {graph}/.default
//   POST /applications                               the caller becomes an owner (OwnedBy)
//   GET  /applications/{objectId}                    404 once deleted; 403/404 when not owned
//   PATCH /applications/{objectId}                   204
//   DELETE /applications/{objectId}                  204
//   POST /applications/{objectId}/addPassword        { keyId, secretText, endDateTime }
//   POST /applications/{objectId}/removePassword     204
//   GET  /groups?$filter=…&$top=&$select=            needs Group.Read.All (or Directory.Read.All)
// Nothing here logs or returns the management secret or a created client secret
// except addPassword's result to its caller.

const TIMEOUT_MS = 15_000;
// Tokens are reused until shortly before they expire.
const TOKEN_MARGIN_MS = 60_000;

export const LOGIN_BASE = "https://login.microsoftonline.com";
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export interface GraphEndpoints {
  login: string;
  graph: string;
}

export interface GraphCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

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
  passwordCredentials?: Array<{ keyId: string; displayName?: string | null; endDateTime?: string | null }>;
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
  createApplication(body: Record<string, unknown>, signal?: AbortSignal): Promise<GraphApplication>;
  // undefined when Graph says 404 (deleted, or not visible to an OwnedBy caller).
  getApplication(objectId: string, signal?: AbortSignal): Promise<GraphApplication | undefined>;
  updateApplication(objectId: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
  deleteApplication(objectId: string, signal?: AbortSignal): Promise<void>;
  addPassword(objectId: string, displayName: string, endDateTime: string, signal?: AbortSignal): Promise<GraphPassword>;
  removePassword(objectId: string, keyId: string, signal?: AbortSignal): Promise<void>;
  groups(search: string, signal?: AbortSignal): Promise<Array<{ id: string; displayName: string }>>;
}

const withTimeout = (signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);

const appPath = (objectId: string) => `/applications/${encodeURIComponent(objectId)}`;

const tokens = new Map<string, { value: string; expires: number }>();

export function createGraphClient(creds: GraphCredentials, endpoints: GraphEndpoints): GraphClient {
  const cacheKey = `${endpoints.login}|${creds.tenantId}|${creds.clientId}|${creds.clientSecret}`;

  async function token(signal?: AbortSignal, fresh = false): Promise<string> {
    const cached = tokens.get(cacheKey);
    if (!fresh && cached && cached.expires > Date.now() + TOKEN_MARGIN_MS) return cached.value;
    const problem = tenantProblem(creds.tenantId);
    if (problem) throw new GraphError(400, "invalid_tenant", problem);
    const res = await fetch(`${endpoints.login}/${encodeURIComponent(creds.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
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
  };
}

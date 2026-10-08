// Just enough of Entra's token endpoint and Microsoft Graph for the
// connector: one management app with configurable roles, applications it
// owns (and some it doesn't), password credentials and groups. Every request
// is recorded without its secrets.
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { GraphEndpoints } from "../../../src/modules/connector-entra/graph.js";

export const TENANT = "00000000-0000-4000-8000-0000000000e1";
export const MGMT_CLIENT = "00000000-0000-4000-8000-0000000000c1";
export const MGMT_SECRET = "mgmt-secret";

export interface FakeApp {
  id: string;
  appId: string;
  displayName: string;
  tags: string[];
  groupMembershipClaims: string | null;
  web: { redirectUris: string[] };
  passwordCredentials: Array<{ keyId: string; displayName: string; endDateTime: string; secretText: string }>;
  owned: boolean;
  body: Record<string, unknown>;
}

export interface FakeGraph {
  endpoints: GraphEndpoints;
  roles: string[];
  apps: Map<string, FakeApp>;
  groups: Array<{ id: string; displayName: string; securityEnabled: boolean }>;
  requests: Array<{ method: string; path: string }>;
  tokensIssued: number;
  // Makes every Graph call (not the token endpoint) answer this status.
  failWith?: number;
  close(): Promise<void>;
}

const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function jwt(payload: Record<string, unknown>): string {
  return `${part({ alg: "none", typ: "JWT" })}.${part(payload)}.sig`;
}

function send(res: http.ServerResponse, status: number, value?: unknown): void {
  if (value === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

const graphError = (res: http.ServerResponse, status: number, code: string, message: string) =>
  send(res, status, { error: { code, message } });

let seq = 0;
const guid = (tag: string) => `00000000-0000-4000-8000-${tag}${String(++seq).padStart(12 - tag.length, "0")}`;

export function publicApp(app: FakeApp) {
  return {
    id: app.id,
    appId: app.appId,
    displayName: app.displayName,
    tags: app.tags,
    groupMembershipClaims: app.groupMembershipClaims,
    web: app.web,
    passwordCredentials: app.passwordCredentials.map(({ keyId, displayName, endDateTime }) => ({
      keyId,
      displayName,
      endDateTime,
    })),
  };
}

export async function startFakeGraph(): Promise<FakeGraph> {
  let base = "";
  let token = "";
  const fake: FakeGraph = {
    endpoints: { login: "", graph: "" },
    roles: ["Application.ReadWrite.OwnedBy", "Group.Read.All"],
    apps: new Map(),
    groups: [
      { id: "g-admins", displayName: "Cluster admins", securityEnabled: true },
      { id: "g-ops", displayName: "Cluster operators", securityEnabled: true },
      { id: "g-o365", displayName: "Cluster chat", securityEnabled: false },
      { id: "g-sales", displayName: "Sales", securityEnabled: true },
    ],
    requests: [],
    tokensIssued: 0,
    close: async () => {},
  };

  const server: Server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", base);
      fake.requests.push({ method: req.method ?? "", path: decodeURIComponent(url.pathname + url.search) });

      if (url.pathname === `/${TENANT}/oauth2/v2.0/token` && req.method === "POST") {
        const form = new URLSearchParams(raw);
        if (form.get("client_id") !== MGMT_CLIENT || form.get("client_secret") !== MGMT_SECRET) {
          return send(res, 401, {
            error: "invalid_client",
            error_description: "AADSTS7000215: Invalid client secret provided.\r\nTrace ID: 1\r\nTimestamp: now",
          });
        }
        fake.tokensIssued++;
        token = jwt({ tid: TENANT, appid: MGMT_CLIENT, roles: fake.roles, n: fake.tokensIssued });
        return send(res, 200, { token_type: "Bearer", expires_in: 3599, access_token: token });
      }
      if (url.pathname.endsWith("/oauth2/v2.0/token")) {
        return send(res, 400, { error: "invalid_request", error_description: "AADSTS90002: Tenant not found." });
      }

      if (!url.pathname.startsWith("/v1.0/")) return graphError(res, 404, "NotFound", "No such path");
      if (req.headers.authorization !== `Bearer ${token}`)
        return graphError(res, 401, "InvalidAuthenticationToken", "Access token is empty or invalid.");
      if (fake.failWith) return graphError(res, fake.failWith, "ServiceUnavailable", "Try again later.");
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const path = url.pathname.slice("/v1.0".length);
      const manage = fake.roles.some((r) => r.startsWith("Application.ReadWrite"));

      if (path === "/applications" && req.method === "POST") {
        if (!manage) return graphError(res, 403, "Authorization_RequestDenied", "Insufficient privileges.");
        const app: FakeApp = {
          id: guid("a"),
          appId: guid("b"),
          displayName: String(body.displayName),
          tags: (body.tags as string[]) ?? [],
          groupMembershipClaims: (body.groupMembershipClaims as string) ?? null,
          web: { redirectUris: ((body.web as { redirectUris?: string[] })?.redirectUris ?? []).slice() },
          passwordCredentials: [],
          owned: true,
          body,
        };
        fake.apps.set(app.id, app);
        return send(res, 201, publicApp(app));
      }

      const appMatch = path.match(/^\/applications\/([^/]+)(\/addPassword|\/removePassword)?$/);
      if (appMatch) {
        const app = fake.apps.get(appMatch[1]!);
        if (!app || !app.owned) return graphError(res, 404, "Request_ResourceNotFound", "Resource does not exist.");
        const action = appMatch[2];
        if (!action && req.method === "GET") return send(res, 200, publicApp(app));
        if (!action && req.method === "PATCH") {
          if (body.web)
            app.web = { redirectUris: ((body.web as { redirectUris: string[] }).redirectUris ?? []).slice() };
          if ("groupMembershipClaims" in body) app.groupMembershipClaims = body.groupMembershipClaims as string;
          return send(res, 204);
        }
        if (!action && req.method === "DELETE") {
          fake.apps.delete(app.id);
          return send(res, 204);
        }
        if (action === "/addPassword" && req.method === "POST") {
          const cred = body.passwordCredential as { displayName: string; endDateTime: string };
          const password = {
            keyId: guid("c"),
            displayName: cred.displayName,
            endDateTime: cred.endDateTime,
            secretText: `secret-${seq}`,
          };
          app.passwordCredentials.push(password);
          return send(res, 200, password);
        }
        if (action === "/removePassword" && req.method === "POST") {
          const before = app.passwordCredentials.length;
          app.passwordCredentials = app.passwordCredentials.filter((p) => p.keyId !== body.keyId);
          return before === app.passwordCredentials.length
            ? graphError(res, 400, "InvalidKeyId", "No such key")
            : send(res, 204);
        }
      }

      if (path === "/groups" && req.method === "GET") {
        if (!fake.roles.some((r) => /^(Group|GroupMember|Directory)\.Read\.All$/.test(r)))
          return graphError(
            res,
            403,
            "Authorization_RequestDenied",
            "Insufficient privileges to complete the operation."
          );
        const filter = url.searchParams.get("$filter") ?? "";
        const prefix = filter.match(/startswith\(displayName,'((?:[^']|'')*)'\)/)?.[1]?.replace(/''/g, "'");
        const value = fake.groups
          .filter((g) => !filter.includes("securityEnabled eq true") || g.securityEnabled)
          .filter((g) => prefix === undefined || g.displayName.toLowerCase().startsWith(prefix.toLowerCase()))
          .map(({ id, displayName }) => ({ id, displayName }));
        return send(res, 200, { value });
      }
      return graphError(res, 400, "BadRequest", `Unhandled ${req.method} ${path}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.endpoints = { login: base, graph: `${base}/v1.0` };
  fake.close = () => new Promise((resolve) => server.close(() => resolve()));
  return fake;
}

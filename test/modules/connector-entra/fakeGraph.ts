// Just enough of Entra's token endpoint and Microsoft Graph for the
// connector: one management app with configurable roles that signs in with
// a secret or a certificate (client assertion), applications it owns (and
// some it doesn't), password and key credentials, and groups. Every request
// is recorded without its secrets.
import crypto from "node:crypto";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { GraphEndpoints } from "../../../src/modules/connector-entra/graph.js";

export const TENANT = "00000000-0000-4000-8000-0000000000e1";
export const MGMT_CLIENT = "00000000-0000-4000-8000-0000000000c1";
export const MGMT_SECRET = "mgmt-secret";

export interface FakeKey {
  keyId: string;
  displayName: string;
  // base64 DER.
  key: string;
}

export interface FakePassword {
  keyId: string;
  displayName: string;
  endDateTime: string;
  secretText: string;
}

export interface FakeApp {
  id: string;
  appId: string;
  displayName: string;
  tags: string[];
  groupMembershipClaims: string | null;
  web: { redirectUris: string[] };
  passwordCredentials: FakePassword[];
  keyCredentials: FakeKey[];
  owned: boolean;
  body: Record<string, unknown>;
}

// The management app registration itself.
export interface FakeManagement {
  id: string;
  passwordCredentials: FakePassword[];
  keyCredentials: FakeKey[];
  // It may read and write itself (it owns itself, or holds
  // Application.ReadWrite.All). Off: plain OwnedBy.
  selfAccess: boolean;
}

export interface FakeGraph {
  endpoints: GraphEndpoints;
  roles: string[];
  apps: Map<string, FakeApp>;
  groups: Array<{ id: string; displayName: string; securityEnabled: boolean }>;
  requests: Array<{ method: string; path: string }>;
  // Mailboxes the management app may send as (Exchange's role scope), and
  // what was sent.
  mailboxes: string[];
  mail: Array<{ from: string; body: Record<string, unknown> }>;
  tokensIssued: number;
  // How each token was asked for.
  tokenCredentials: Array<"secret" | "certificate">;
  management: FakeManagement;
  // The tenant refuses certificates on app registrations (PATCH keyCredentials).
  refuseKeys?: boolean;
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

const publicPasswords = (list: FakePassword[]) =>
  list.map(({ keyId, displayName, endDateTime, secretText }) => ({
    keyId,
    displayName,
    endDateTime,
    hint: secretText.slice(0, 3),
  }));

// Graph never returns a certificate's key.
const publicKeys = (list: FakeKey[]) =>
  list.map(({ keyId, displayName }) => ({ keyId, displayName, type: "AsymmetricX509Cert", key: null }));

export function publicApp(app: FakeApp) {
  return {
    id: app.id,
    appId: app.appId,
    displayName: app.displayName,
    tags: app.tags,
    groupMembershipClaims: app.groupMembershipClaims,
    web: app.web,
    passwordCredentials: publicPasswords(app.passwordCredentials),
    keyCredentials: publicKeys(app.keyCredentials),
  };
}

// The certificate among `keys` whose x5t a JWT names, if its signature checks.
function verifiedBy(jwtText: string, keys: FakeKey[]): Record<string, unknown> | undefined {
  const [h, p, sig] = jwtText.split(".");
  if (!h || !p || !sig) return undefined;
  const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { x5t?: string; alg?: string };
  const key = keys.find(
    (k) => crypto.createHash("sha1").update(Buffer.from(k.key, "base64")).digest("base64url") === header.x5t
  );
  if (!key || header.alg !== "RS256") return undefined;
  const cert = new crypto.X509Certificate(Buffer.from(key.key, "base64"));
  if (!crypto.verify("sha256", Buffer.from(`${h}.${p}`), cert.publicKey, Buffer.from(sig, "base64url")))
    return undefined;
  const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return undefined;
  return claims;
}

const keysFrom = (body: Record<string, unknown>): FakeKey[] =>
  ((body.keyCredentials as Array<{ key: string; displayName: string }>) ?? []).map((k) => ({
    keyId: guid("d"),
    displayName: k.displayName,
    key: k.key,
  }));

export async function startFakeGraph(): Promise<FakeGraph> {
  let base = "";
  let token = "";
  // Every token issued stays valid, as Entra's do until they expire.
  const issued = new Set<string>();
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
    mailboxes: [],
    mail: [],
    tokensIssued: 0,
    tokenCredentials: [],
    management: {
      id: guid("m"),
      passwordCredentials: [
        { keyId: guid("p"), displayName: "pasted", endDateTime: "2028-01-01T00:00:00Z", secretText: MGMT_SECRET },
      ],
      keyCredentials: [],
      selfAccess: false,
    },
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
        const assertion = form.get("client_assertion");
        let how: "secret" | "certificate";
        if (assertion) {
          const claims = verifiedBy(assertion, fake.management.keyCredentials);
          const ok =
            form.get("client_assertion_type") === "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" &&
            claims?.iss === MGMT_CLIENT &&
            claims.sub === MGMT_CLIENT &&
            claims.aud === `${base}/${TENANT}/oauth2/v2.0/token`;
          if (form.get("client_id") !== MGMT_CLIENT || !ok) {
            return send(res, 401, {
              error: "invalid_client",
              error_description:
                "AADSTS700027: The certificate with identifier used to sign the client assertion is not registered on application.\r\nTrace ID: 1",
            });
          }
          how = "certificate";
        } else {
          const secret = form.get("client_secret");
          if (
            form.get("client_id") !== MGMT_CLIENT ||
            !fake.management.passwordCredentials.some((p) => p.secretText === secret)
          ) {
            return send(res, 401, {
              error: "invalid_client",
              error_description: "AADSTS7000215: Invalid client secret provided.\r\nTrace ID: 1\r\nTimestamp: now",
            });
          }
          how = "secret";
        }
        fake.tokenCredentials.push(how);
        fake.tokensIssued++;
        token = jwt({ tid: TENANT, appid: MGMT_CLIENT, roles: fake.roles, n: fake.tokensIssued });
        issued.add(token);
        return send(res, 200, { token_type: "Bearer", expires_in: 3599, access_token: token });
      }
      if (url.pathname.endsWith("/oauth2/v2.0/token")) {
        return send(res, 400, { error: "invalid_request", error_description: "AADSTS90002: Tenant not found." });
      }

      if (!url.pathname.startsWith("/v1.0/")) return graphError(res, 404, "NotFound", "No such path");
      if (!issued.has((req.headers.authorization ?? "").replace(/^Bearer /, "")))
        return graphError(res, 401, "InvalidAuthenticationToken", "Access token is empty or invalid.");
      if (fake.failWith) return graphError(res, fake.failWith, "ServiceUnavailable", "Try again later.");
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const path = url.pathname.slice("/v1.0".length);
      const manage = fake.roles.some((r) => r.startsWith("Application.ReadWrite"));

      const mailTo = /^\/users\/([^/]+)\/sendMail$/.exec(path);
      if (mailTo && req.method === "POST") {
        const from = decodeURIComponent(mailTo[1]!);
        if (!fake.mailboxes.includes(from)) return graphError(res, 403, "ErrorAccessDenied", "Access is denied.");
        fake.mail.push({ from, body });
        return send(res, 202);
      }

      const mgmt = fake.management;
      const selfMatch = path.match(
        new RegExp(`^/applications(?:\\(appId='${MGMT_CLIENT}'\\)|/${mgmt.id})(/addKey|/removeKey|/removePassword)?$`)
      );
      if (selfMatch) {
        const action = selfMatch[1];
        const denied = () => graphError(res, 403, "Authorization_RequestDenied", "Insufficient privileges.");
        if (action === "/addKey" || action === "/removeKey") {
          const proof = verifiedBy(String(body.proof ?? ""), mgmt.keyCredentials);
          if (!proof || proof.iss !== mgmt.id || proof.aud !== "00000002-0000-0000-c000-000000000000")
            return graphError(res, 401, "Authorization_IdentityNotFound", "Proof of possession is invalid.");
          if (action === "/addKey") {
            const [key] = keysFrom({ keyCredentials: [body.keyCredential] });
            mgmt.keyCredentials.push(key!);
            return send(res, 200, publicKeys([key!])[0]);
          }
          const before = mgmt.keyCredentials.length;
          mgmt.keyCredentials = mgmt.keyCredentials.filter((k) => k.keyId !== body.keyId);
          return before === mgmt.keyCredentials.length
            ? graphError(res, 404, "NotFound", "No such key")
            : send(res, 204);
        }
        if (!mgmt.selfAccess) return denied();
        if (!action && req.method === "GET")
          return send(res, 200, {
            id: mgmt.id,
            appId: MGMT_CLIENT,
            displayName: "management",
            passwordCredentials: publicPasswords(mgmt.passwordCredentials),
            keyCredentials: publicKeys(mgmt.keyCredentials),
          });
        if (!action && req.method === "PATCH") {
          if (body.keyCredentials) mgmt.keyCredentials = keysFrom(body);
          return send(res, 204);
        }
        if (action === "/removePassword") {
          mgmt.passwordCredentials = mgmt.passwordCredentials.filter((p) => p.keyId !== body.keyId);
          return send(res, 204);
        }
      }

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
          keyCredentials: keysFrom(body),
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
          if (body.keyCredentials) {
            if (fake.refuseKeys)
              return graphError(
                res,
                400,
                "KeyCredentialsInvalidEndDate",
                "Certificates are not allowed by tenant policy."
              );
            app.keyCredentials = keysFrom(body);
          }
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

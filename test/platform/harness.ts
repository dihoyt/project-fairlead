// Boots the real app with the real platform (no identify hook), so every
// request goes through the platform's own sessions, and a fake OIDC provider
// tests can point it at.
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database } from "better-sqlite3";
import { createApp } from "../../src/app.js";
import type { Module } from "../../src/contracts/module.js";
import { hashPassword } from "../../src/platform/auth/passwords.js";
import { createUser, type NewUser, type UserRow } from "../../src/platform/auth/users.js";
import { createPlatform } from "../../src/platform/index.js";
import { createSecrets } from "../../src/platform/secrets.js";
import { createSettings, type PlatformSettings } from "../../src/platform/settings.js";
import { openDatabase } from "../../src/runtime/db.js";
import { createRuntime } from "../../src/runtime/index.js";
import { silentLogger } from "../../src/runtime/log.js";
import { listen } from "../runtime/helpers.js";

export const TEST_SECRETS_KEY = "test-secrets-key-0123456789";

// Values tests change are put back by each boot, so no test sees another's.
const ENV_RESET = [
  "DEV_AUTH",
  "ADMIN_USERS",
  "ADMIN_GROUPS",
  "TRUSTED_PROXIES",
  "CLIENT_IP_HEADER",
  "BOOTSTRAP_ADMIN_PASSWORD",
  "SITE_NAME",
  "AUTH_PASSWORD_ENABLED",
];

export interface Booted {
  url: string;
  db: Database;
  settings: PlatformSettings;
  makeUser(username: string, password: string | null, extra?: Partial<NewUser>): Promise<UserRow>;
  login(
    username: string,
    password: string,
    headers?: Record<string, string>
  ): Promise<{ res: Response; cookie: string; body: Record<string, unknown> }>;
  get(path: string, cookie?: string, headers?: Record<string, string>): Promise<Response>;
  send(method: string, path: string, body?: unknown, cookie?: string): Promise<Response>;
  setOidcSecret(value: string): Promise<void>;
  close(): Promise<void>;
}

export function cookieFrom(res: Response): string {
  const raw = res.headers
    .getSetCookie()
    .find((line) => /^[a-z0-9_-]+_session=/.test(line) && !line.includes("Max-Age=0"));
  return raw ? raw.split(";")[0]! : "";
}

export async function boot(
  options: { modules?: readonly Module[]; env?: Record<string, string> } = {}
): Promise<Booted> {
  for (const name of ENV_RESET) delete process.env[name];
  process.env.SECRETS_KEY = TEST_SECRETS_KEY;
  delete process.env.PUBLIC_ORIGIN;
  Object.assign(process.env, options.env ?? {});

  const db = openDatabase(":memory:");
  const runtime = await createRuntime({
    db,
    dataDir: "/tmp",
    modules: options.modules ?? [],
    createPlatform,
    logFor: () => silentLogger,
  });
  const server = await listen(createApp(runtime, { version: "test" }));
  process.env.PUBLIC_ORIGIN = server.url;
  const settings = createSettings(db, "default");
  const secrets = createSecrets(db, "default");

  const booted: Booted = {
    url: server.url,
    db,
    settings,
    async makeUser(username, password, extra = {}) {
      return createUser(db, {
        orgId: "default",
        username,
        passwordHash: password === null ? null : await hashPassword(password),
        role: "user",
        ...extra,
      });
    },
    async login(username, password, headers = {}) {
      const res = await fetch(`${server.url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ username, password }),
      });
      return { res, cookie: cookieFrom(res), body: (await res.json()) as Record<string, unknown> };
    },
    get: (path, cookie = "", headers = {}) => fetch(`${server.url}${path}`, { headers: { cookie, ...headers } }),
    send(method, path, body, cookie = "") {
      const init: RequestInit = { method, headers: { cookie } };
      if (body !== undefined) {
        init.headers = { cookie, "content-type": "application/json" };
        init.body = JSON.stringify(body);
      }
      return fetch(`${server.url}${path}`, init);
    },
    setOidcSecret: (value) => secrets.put("auth", "oidc", value),
    async close() {
      await server.close();
      await runtime.stop();
      db.close();
    },
  };
  return booted;
}

// An OIDC provider that issues whatever claims the test asks for next,
// against the nonce the platform sent it.
export interface FakeIssuer {
  url: string;
  next(claims: Record<string, unknown>): void;
  setNonce(nonce: string): void;
  close(): Promise<void>;
}

const jwtPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function unsignedJwt(claims: Record<string, unknown>): string {
  return `${jwtPart({ alg: "none" })}.${jwtPart(claims)}.`;
}

export async function fakeIssuer(clientId = "platform-client", secret = "client-secret"): Promise<FakeIssuer> {
  let issuer = "";
  let claims: Record<string, unknown> = {};
  let nonce = "";
  const server: Server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/.well-known/openid-configuration") {
      res.end(
        JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` })
      );
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      if (req.headers.authorization !== `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "invalid_client" }));
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      res.end(
        JSON.stringify({
          id_token: unsignedJwt({ iss: issuer, aud: clientId, exp: now + 300, iat: now, nonce, ...claims }),
        })
      );
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: issuer,
    next: (value) => {
      claims = value;
    },
    setNonce: (value) => {
      nonce = value;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export async function configureOidc(app: Booted, issuer: FakeIssuer, extra: Record<string, unknown> = {}) {
  app.settings.set("auth.oidc.enabled", true, "test");
  app.settings.set("auth.oidc.issuer", issuer.url, "test");
  app.settings.set("auth.oidc.clientId", "platform-client", "test");
  for (const [key, value] of Object.entries(extra)) app.settings.set(key, value, "test");
  await app.setOidcSecret("client-secret");
}

// The browser's side of the flow: start, read the state and nonce off the
// redirect to the provider, then call back as the provider would.
export async function oidcSignIn(
  app: Booted,
  issuer: FakeIssuer,
  claims: Record<string, unknown>,
  options: { cookie?: string; link?: boolean; start?: string } = {}
) {
  const cookie = options.cookie ?? "";
  const start = await fetch(`${app.url}${options.start ?? `/auth/oidc/start${options.link ? "?link=1" : ""}`}`, {
    redirect: "manual",
    headers: { cookie },
  });
  if (start.status !== 303) throw new Error(`start answered ${start.status}`);
  const authorize = new URL(start.headers.get("location")!);
  if (authorize.origin !== issuer.url) throw new Error(`start redirected to ${authorize}`);
  issuer.setNonce(authorize.searchParams.get("nonce")!);
  issuer.next(claims);
  const callback = await fetch(`${app.url}/auth/oidc/callback?code=abc&state=${authorize.searchParams.get("state")}`, {
    redirect: "manual",
    headers: { cookie },
  });
  return { authorize, callback, location: callback.headers.get("location") ?? "", cookie: cookieFrom(callback) };
}

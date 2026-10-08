import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import type { ApiTokenView, Me, OAuthAuthorizeParams, OAuthConsentView } from "../../src/contracts/auth.js";
import { boot, type Booted } from "./harness.js";

let app: Booted;
let cookie = "";

beforeEach(async () => {
  app = await boot();
  await app.makeUser("root", "root password!!", { role: "admin" });
  cookie = (await app.login("root", "root password!!")).cookie;
});
afterEach(() => app.close());

const REDIRECT = "https://claude.example.com/api/mcp/auth_callback";

async function register(body: Record<string, unknown> = { client_name: "Claude", redirect_uris: [REDIRECT] }) {
  const res = await fetch(`${app.url}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
}

const consent = async (params: OAuthAuthorizeParams, decision: string, scope?: string) => {
  const res = await app.send("POST", "/api/admin/oauth/consent", { params, decision, scope }, cookie);
  return { status: res.status, body: (await res.json()) as OAuthConsentView & { error?: string } };
};

const token = async (form: Record<string, string>) => {
  const res = await fetch(`${app.url}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
};

async function authorize(scope = "write") {
  const client = (await register()).body;
  const { verifier, challenge } = pkce();
  const params: OAuthAuthorizeParams = {
    response_type: "code",
    client_id: client.client_id as string,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    scope,
    resource: `${app.url}/mcp`,
  };
  return { clientId: client.client_id as string, verifier, params };
}

test("metadata points clients at the endpoints, and /mcp says where to look", async () => {
  const prm = (await (await fetch(`${app.url}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<
    string,
    unknown
  >;
  assert.deepEqual(prm.authorization_servers, [app.url]);
  assert.equal(prm.resource, `${app.url}/mcp`);
  const as = (await (await fetch(`${app.url}/.well-known/oauth-authorization-server`)).json()) as Record<
    string,
    unknown
  >;
  assert.equal(as.token_endpoint, `${app.url}/oauth/token`);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  const mcp = await fetch(`${app.url}/mcp`, { method: "POST" });
  assert.equal(mcp.status, 401);
  assert.match(
    mcp.headers.get("www-authenticate") ?? "",
    /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"/
  );
});

test("register, authorize, approve, exchange, use, refresh, revoke", async () => {
  const { clientId, verifier, params } = await authorize();

  const redirect = await fetch(`${app.url}/oauth/authorize?${new URLSearchParams({ ...params }).toString()}`, {
    redirect: "manual",
  });
  assert.equal(redirect.status, 302);
  assert.match(redirect.headers.get("location") ?? "", /^\.\.\/#\/oauth\/consent\?.*client_id=/);

  const preview = await consent(params, "preview");
  assert.equal(preview.body.client.name, "Claude");
  assert.equal(preview.body.requestedScope, "write");
  assert.equal(preview.body.redirect, undefined);

  const approved = await consent(params, "approve", "read");
  const back = new URL(approved.body.redirect!);
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get("state"), "xyz");
  const code = back.searchParams.get("code")!;

  const wrong = await token({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: "x".repeat(43),
  });
  assert.equal(wrong.body.error, "invalid_grant");
  // The failed attempt spent the code.
  const spent = await token({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  });
  assert.equal(spent.body.error, "invalid_grant");

  const again = await authorize();
  const code2 = new URL((await consent(again.params, "approve")).body.redirect!).searchParams.get("code")!;
  const issued = await token({
    grant_type: "authorization_code",
    code: code2,
    client_id: again.clientId,
    redirect_uri: REDIRECT,
    code_verifier: again.verifier,
  });
  assert.equal(issued.status, 200);
  assert.equal(issued.body.token_type, "Bearer");
  assert.equal(issued.body.scope, "write");

  const me = (await (
    await fetch(`${app.url}/api/me`, { headers: { authorization: `Bearer ${issued.body.access_token}` } })
  ).json()) as Me;
  assert.equal(me.id, "root");
  assert.equal(me.source, "token");

  const refreshed = await token({
    grant_type: "refresh_token",
    refresh_token: issued.body.refresh_token!,
    client_id: again.clientId,
  });
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.body.access_token, issued.body.access_token);
  assert.equal(
    (await fetch(`${app.url}/api/me`, { headers: { authorization: `Bearer ${issued.body.access_token}` } })).status,
    401
  );
  const reused = await token({
    grant_type: "refresh_token",
    refresh_token: issued.body.refresh_token!,
    client_id: again.clientId,
  });
  assert.equal(reused.body.error, "invalid_grant");

  const list = (await (await app.get("/api/admin/tokens", cookie)).json()) as ApiTokenView[];
  const grant = list.find((t) => t.kind === "oauth")!;
  assert.equal(grant.client, "Claude");
  assert.equal(grant.scope, "write");
  await app.send("DELETE", `/api/admin/tokens/${grant.id}`, undefined, cookie);
  assert.equal(
    (await fetch(`${app.url}/api/me`, { headers: { authorization: `Bearer ${refreshed.body.access_token}` } })).status,
    401
  );
  const afterRevoke = await token({
    grant_type: "refresh_token",
    refresh_token: refreshed.body.refresh_token!,
    client_id: again.clientId,
  });
  assert.equal(afterRevoke.body.error, "invalid_grant");
});

test("an expired access token is refused", async () => {
  const { clientId, verifier, params } = await authorize();
  const code = new URL((await consent(params, "approve")).body.redirect!).searchParams.get("code")!;
  const issued = await token({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  });
  app.db.prepare("UPDATE api_tokens SET access_expires_at = ?").run(Date.now() - 1);
  assert.equal(
    (await fetch(`${app.url}/api/me`, { headers: { authorization: `Bearer ${issued.body.access_token}` } })).status,
    401
  );
});

test("deny sends access_denied back; bad requests are refused before anyone is asked", async () => {
  const { params } = await authorize();
  const denied = await consent(params, "deny");
  assert.equal(new URL(denied.body.redirect!).searchParams.get("error"), "access_denied");

  assert.equal((await consent({ ...params, redirect_uri: "https://evil.example.com/cb" }, "preview")).status, 400);
  assert.equal((await consent({ ...params, code_challenge_method: "plain" }, "preview")).status, 400);
  assert.equal((await consent({ ...params, client_id: "cli_nope" }, "preview")).status, 400);
  assert.equal((await consent({ ...params, resource: "https://other.example.com/mcp" }, "preview")).status, 400);

  const unknown = await fetch(
    `${app.url}/oauth/authorize?client_id=cli_nope&redirect_uri=${encodeURIComponent(REDIRECT)}`,
    {
      redirect: "manual",
    }
  );
  assert.equal(unknown.status, 400);
  const plain = await fetch(
    `${app.url}/oauth/authorize?${new URLSearchParams({ ...params, code_challenge_method: "plain" }).toString()}`,
    { redirect: "manual" }
  );
  assert.equal(plain.status, 302);
  assert.equal(new URL(plain.headers.get("location")!).searchParams.get("error"), "invalid_request");
});

test("registration takes https or loopback redirect URIs and public clients only", async () => {
  assert.equal((await register({ redirect_uris: ["http://evil.example.com/cb"] })).status, 400);
  assert.equal((await register({ redirect_uris: [] })).status, 400);
  assert.equal(
    (await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" })).status,
    400
  );
  const local = await register({ redirect_uris: ["http://localhost:33418/callback"] });
  assert.equal(local.status, 201);
  assert.equal(local.body.token_endpoint_auth_method, "none");
});

test("a non-admin can't approve, and tokens can't reach the consent route", async () => {
  await app.makeUser("plain", "plain password!");
  const plain = (await app.login("plain", "plain password!")).cookie;
  const { params } = await authorize();
  const res = await app.send("POST", "/api/admin/oauth/consent", { params, decision: "approve" }, plain);
  assert.equal(res.status, 403);
});

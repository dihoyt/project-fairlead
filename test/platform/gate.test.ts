import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Module } from "../../src/contracts/module.js";
import { GATE_EMAIL_HEADER, GATE_FORWARD_PATH, GATE_USER_HEADER } from "../../src/contracts/platform.js";
import { CALLBACK_PATH, GATE_COOKIE } from "../../src/platform/routes/gate.js";
import { boot, type Booted } from "./harness.js";

const APP = "longhorn.example.test";

const allowExampleHosts: Module = {
  id: "deploy",
  milestone: "A",
  migrations: [],
  register(ctx) {
    ctx.services.get("gate").allowHosts((host) => host.endsWith(".example.test"));
  },
};

let app: Booted;
let cookie = "";

beforeEach(async () => {
  app = await boot({ modules: [allowExampleHosts] });
  await app.makeUser("root", "root password!!", { role: "admin", email: "root@example.test" });
  await app.makeUser("member", "member password!!");
  cookie = (await app.login("root", "root password!!")).cookie;
});
afterEach(() => app.close());

// What Traefik's forwardAuth sends for a request to the app.
function forward(uri: string, headers: Record<string, string> = {}, query = "?proto=https") {
  return fetch(`${app.url}${GATE_FORWARD_PATH}${query}`, {
    redirect: "manual",
    headers: {
      "x-forwarded-host": APP,
      "x-forwarded-uri": uri,
      "x-forwarded-proto": "http",
      "x-forwarded-method": "GET",
      accept: "text/html,application/xhtml+xml",
      ...headers,
    },
  });
}

const gate = (rd: string, withCookie = cookie) =>
  fetch(`${app.url}/auth/gate?rd=${encodeURIComponent(rd)}`, { redirect: "manual", headers: { cookie: withCookie } });

// The whole round trip: forward -> console -> callback -> the app's cookie.
async function signInToApp(withCookie = cookie): Promise<string> {
  const first = await forward("/#/volume");
  const toConsole = first.headers.get("location")!;
  const ticketed = await fetch(toConsole, { redirect: "manual", headers: { cookie: withCookie } });
  assert.equal(ticketed.status, 302);
  const callback = new URL(ticketed.headers.get("location")!);
  assert.equal(callback.host, APP);
  assert.equal(callback.pathname, CALLBACK_PATH);
  const swapped = await forward(`${callback.pathname}${callback.search}`);
  assert.equal(swapped.status, 302);
  assert.equal(swapped.headers.get("location"), `https://${APP}/`);
  const set = swapped.headers.get("set-cookie") ?? "";
  assert.match(set, new RegExp(`^${GATE_COOKIE}=`));
  assert.match(set, /HttpOnly/);
  assert.match(set, /Secure/);
  return set.split(";")[0]!;
}

test("a browser with no cookie is sent to sign in at the console, back to where it was going", async () => {
  const res = await forward("/dashboard?x=1");
  assert.equal(res.status, 302);
  assert.equal(
    res.headers.get("location"),
    `${app.url}/auth/gate?rd=${encodeURIComponent(`https://${APP}/dashboard?x=1`)}`
  );
});

test("anything that isn't a page load is answered 401, with a Basic challenge only for credentials apps", async () => {
  const api = await forward("/v1/volumes", { accept: "application/json" });
  assert.equal(api.status, 401);
  assert.equal(api.headers.get("www-authenticate"), null);
  const git = await forward("/org/repo.git/info/refs", { accept: "*/*" }, "?proto=https&credentials=1");
  assert.equal(git.status, 401);
  assert.match(git.headers.get("www-authenticate") ?? "", /^Basic/);
});

test("a request with its own Authorization passes only where the app checks it", async () => {
  const strict = await forward("/", { authorization: "Basic eDp5" });
  assert.equal(strict.status, 302);
  const credentials = await forward("/", { authorization: "Basic eDp5" }, "?proto=https&credentials=1");
  assert.equal(credentials.status, 200);
});

test("the round trip gives the app host its own cookie, which then passes with who it is", async () => {
  const appCookie = await signInToApp();
  const res = await forward("/#/volume", { cookie: appCookie });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get(GATE_USER_HEADER), "root");
  assert.equal(res.headers.get(GATE_EMAIL_HEADER), "root@example.test");
  assert.equal(res.headers.get("set-cookie"), null);
  // Bound to the host it was issued for.
  const elsewhere = await forward("/", { cookie: appCookie, "x-forwarded-host": "gitea.example.test" });
  assert.equal(elsewhere.status, 302);
});

test("a ticket works once, and only on its own host", async () => {
  const toConsole = (await forward("/")).headers.get("location")!;
  const callback = new URL(
    (await fetch(toConsole, { redirect: "manual", headers: { cookie } })).headers.get("location")!
  );
  const path = `${callback.pathname}${callback.search}`;
  assert.equal((await forward(path, { "x-forwarded-host": "gitea.example.test" })).status, 403);
  // Spent by the wrong host's attempt.
  assert.equal((await forward(path)).status, 403);
});

test("signing out of the console signs out of every app", async () => {
  const appCookie = await signInToApp();
  await app.send("POST", "/api/auth/logout", {}, cookie);
  assert.equal((await forward("/", { cookie: appCookie })).status, 302);
});

test("members are kept out unless the gate lets everyone in", async () => {
  const memberCookie = (await app.login("member", "member password!!")).cookie;
  assert.equal((await gate(`https://${APP}/`, memberCookie)).status, 403);
  app.settings.set("auth.gate.allow", "everyone", "test");
  await signInToApp(memberCookie);
});

test("the console only sends people back to hosts a module allows", async () => {
  const res = await gate("https://evil.example.com/");
  assert.equal(res.status, 400);
  assert.equal((await gate("javascript:alert(1)")).status, 400);
});

test("someone not signed in to the console is sent to the client's gate page first", async () => {
  const res = await gate(`https://${APP}/x`, "");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `../#/gate?rd=${encodeURIComponent(`https://${APP}/x`)}`);
});

test("without a public URL a browser is told why instead of being sent nowhere", async () => {
  delete process.env.PUBLIC_ORIGIN;
  const res = await forward("/");
  assert.equal(res.status, 503);
  assert.match(await res.text(), /no public URL/);
});

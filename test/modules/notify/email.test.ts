import { test, mock as nodeMock } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createMockContext, mockAdmin } from "../../../src/contracts/mocks/context.js";
import { createMockEntraMail } from "../../../src/contracts/mocks/notify.js";
import type { ChannelView, EmailSetupView, TestSendResult } from "../../../src/contracts/notify.js";
import type { User } from "../../../src/contracts/index.js";
import notify, { register } from "../../../src/modules/notify/index.js";
import type { OAuthEndpoints } from "../../../src/modules/notify/email.js";
import { compose } from "../../../src/modules/notify/email.js";

const realFetch = globalThis.fetch;

// A minimal SMTP server: plain text, AUTH PLAIN, records each message.
async function fakeSmtp(opts: { password?: string } = {}) {
  const messages: Array<{ from: string; to: string[]; data: string; auth?: string }> = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let inData = false;
    let current: { from: string; to: string[]; data: string; auth?: string } = { from: "", to: [], data: "" };
    let auth: string | undefined;
    socket.write("220 fake.example.test ESMTP\r\n");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          messages.push({ ...current, ...(auth ? { auth } : {}) });
          current = { from: "", to: [], data: "" };
          socket.write("250 2.0.0 queued as FAKE1\r\n");
          continue;
        }
        const nl = buffer.indexOf("\r\n");
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO" || verb === "HELO") socket.write("250-fake.example.test\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (verb === "AUTH") {
          const decoded = Buffer.from(line.split(" ")[2] ?? "", "base64")
            .toString("utf8")
            .split("\0");
          if (opts.password && decoded[2] !== opts.password) {
            socket.write("535 5.7.8 Username and Password not accepted\r\n");
          } else {
            auth = decoded[1];
            socket.write("235 2.7.0 Accepted\r\n");
          }
        } else if (verb === "MAIL") {
          current.from = line;
          socket.write("250 OK\r\n");
        } else if (verb === "RCPT") {
          current.to.push(line);
          socket.write("250 OK\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (verb === "QUIT") {
          socket.end("221 bye\r\n");
        } else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    messages,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const ENDPOINTS: OAuthEndpoints = {
  google: {
    authorize: "https://google.test/auth",
    token: "https://google.test/token",
    send: "https://google.test/send",
  },
  microsoft: {
    authorize: "https://ms.test/authorize",
    token: "https://ms.test/token",
    send: "https://ms.test/sendMail",
  },
};

const idToken = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

// Fake Google / Microsoft: the token endpoint answers from `tokens`, the send
// endpoints record what arrives.
function stubProviders(answers: { tokens?: (form: URLSearchParams) => unknown; sendStatus?: number } = {}) {
  const sent: Captured[] = [];
  const stub = nodeMock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
    const body = String(init?.body ?? "");
    sent.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
    if (url.endsWith("/token")) {
      const answer = answers.tokens?.(new URLSearchParams(body)) ?? { access_token: "at-1" };
      return new Response(JSON.stringify(answer), {
        status: (answer as { error?: string }).error ? 400 : 200,
        headers: { "content-type": "application/json" },
      });
    }
    const status = answers.sendStatus ?? 202;
    return new Response(
      status < 300 ? "" : JSON.stringify({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }),
      {
        status,
      }
    );
  });
  return { sent, restore: () => stub.mock.restore() };
}

async function setup(services: Parameters<typeof createMockContext>[1] extends infer O ? O : never = {}) {
  const m = createMockContext("notify", { migrations: notify.migrations ?? [], ...services });
  register(m.ctx, { endpoints: ENDPOINTS });
  const server: Server = await new Promise((resolve) => {
    const s = m.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/notify`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await realFetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A redirect has no JSON body.
    }
    return { status: res.status, body: parsed, location: res.headers.get("location") ?? "" };
  };
  return {
    m,
    call,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await m.close();
    },
  };
}

test("an SMTP channel sends text and HTML through the server, signed in", async () => {
  const smtp = await fakeSmtp({ password: "app-pass-1234" });
  const t = await setup();
  try {
    const created = await t.call("POST", "/channels", {
      kind: "email",
      label: "Mail",
      config: {
        email: {
          preset: "smtp",
          host: "127.0.0.1",
          port: smtp.port,
          security: "none",
          username: "alerts@example.com",
          from: "alerts@example.com",
          to: ["ops@example.com", "ops@example.com"],
        },
      },
      secret: "app-pass-1234",
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const view = created.body as ChannelView;
    assert.equal(view.config.email?.mode, "smtp");
    assert.deepEqual(view.config.email?.to, ["ops@example.com"]);
    assert.equal(view.hasSecret, true);

    const sent = await t.call("POST", `/channels/${view.id}/test`);
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body, { ok: true, status: 250 });
    assert.equal(smtp.messages.length, 1);
    const msg = smtp.messages[0]!;
    assert.equal(msg.auth, "alerts@example.com");
    assert.match(msg.data, /Subject: \[WARN\] Test notification/);
    assert.match(msg.data, /text\/plain/);
    assert.match(msg.data, /text\/html/);
  } finally {
    await t.close();
    await smtp.close();
  }
});

test("a refused SMTP login reports the server's reply without the password", async () => {
  const smtp = await fakeSmtp({ password: "right-password" });
  const t = await setup();
  try {
    const created = await t.call("POST", "/channels", {
      kind: "email",
      label: "Mail",
      config: {
        email: {
          preset: "gmail",
          host: "127.0.0.1",
          port: smtp.port,
          security: "none",
          username: "wrong-password",
          from: "a@example.com",
          to: ["b@example.com"],
        },
      },
      secret: "wrong-password",
    });
    const id = (created.body as ChannelView).id;
    const result = (await t.call("POST", `/channels/${id}/test`)).body as TestSendResult;
    assert.equal(result.ok, false);
    assert.equal(result.status, 535);
    assert.match(result.error ?? "", /535/);
    assert.match(result.response ?? "", /not accepted/);
    assert.doesNotMatch(JSON.stringify(result), /wrong-password/);
    const listed = (await t.call("GET", "/channels")).body as ChannelView[];
    assert.match(listed[0]!.lastError ?? "", /535/);
  } finally {
    await t.close();
    await smtp.close();
  }
});

test("email channels are validated", async () => {
  const t = await setup();
  try {
    const base = { kind: "email", label: "Mail" };
    const bad = [
      { ...base, config: { email: { preset: "smtp", host: "mail.example.com", from: "a@example.com", to: [] } } },
      { ...base, config: { email: { preset: "smtp", from: "a@example.com", to: ["b@example.com"] } } },
      { ...base, config: { email: { preset: "smtp", host: "x", from: "nope", to: ["b@example.com"] } } },
      { ...base, config: { email: { preset: "entra", to: ["b@example.com"] } } },
      { ...base, config: { email: { preset: "google-oauth", clientId: "c", to: ["b@example.com"] } } },
      {
        ...base,
        config: { email: { preset: "smtp", host: "x", username: "u", from: "a@example.com", to: ["b@example.com"] } },
      },
      { ...base },
    ];
    for (const body of bad) {
      const res = await t.call("POST", "/channels", body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  } finally {
    await t.close();
  }
});

async function oauthChannel(t: Awaited<ReturnType<typeof setup>>, preset: "google-oauth" | "microsoft-oauth") {
  const created = await t.call("POST", "/channels", {
    kind: "email",
    label: "Signed in",
    config: { email: { preset, clientId: "client-1", to: ["me@example.com"] } },
    secret: "client-secret-xyz",
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return created.body as ChannelView;
}

test("sign in to send with Google: PKCE start, callback, then Gmail send as the account", async () => {
  const t = await setup();
  const providers = stubProviders({
    tokens: (form) =>
      form.get("grant_type") === "authorization_code"
        ? { access_token: "at-1", refresh_token: "rt-google", id_token: idToken({ email: "me@gmail.example" }) }
        : { access_token: "at-2" },
  });
  try {
    const channel = await oauthChannel(t, "google-oauth");
    const setupView = (await t.call("GET", "/email/setup")).body as EmailSetupView;
    assert.equal(setupView.redirectUri, "https://console.example.test/api/notify/oauth/callback");

    const start = await t.call("POST", `/channels/${channel.id}/oauth`);
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const url = new URL((start.body as { url: string }).url);
    assert.equal(url.origin + url.pathname, ENDPOINTS.google.authorize);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.match(url.searchParams.get("scope") ?? "", /gmail\.send/);
    const state = url.searchParams.get("state")!;

    const back = await t.call("GET", `/oauth/callback?state=${state}&code=the-code`);
    assert.equal(back.status, 303);
    assert.equal(back.location, `https://console.example.test/#/notifications?channel=${channel.id}&oauth=ok`);
    const exchange = new URLSearchParams(providers.sent.find((s) => s.url === ENDPOINTS.google.token)!.body);
    assert.equal(exchange.get("code"), "the-code");
    assert.ok(exchange.get("code_verifier"));
    assert.equal(exchange.get("client_secret"), "client-secret-xyz");
    assert.ok([...t.m.secrets.values()].includes("rt-google"));

    const view = ((await t.call("GET", "/channels")).body as ChannelView[])[0]!;
    assert.equal(view.config.email?.account, "me@gmail.example");
    assert.ok(t.m.audit.some((a) => a.action === "notify.oauth"));

    // The state is single use.
    const again = await t.call("GET", `/oauth/callback?state=${state}&code=the-code`);
    assert.match(again.location, /oauth=error/);

    const sent = (await t.call("POST", `/channels/${channel.id}/test`)).body as TestSendResult;
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const gmail = providers.sent.find((s) => s.url === ENDPOINTS.google.send)!;
    assert.equal(gmail.headers.authorization, "Bearer at-2");
    const raw = Buffer.from((JSON.parse(gmail.body) as { raw: string }).raw, "base64url").toString("utf8");
    assert.match(raw, /From: me@gmail\.example/);
    assert.match(raw, /To: me@example\.com/);
  } finally {
    providers.restore();
    await t.close();
  }
});

test("Microsoft sign-in keeps the rotated refresh token and sends MIME to Graph", async () => {
  const t = await setup();
  let refreshes = 0;
  const providers = stubProviders({
    tokens: (form) => {
      if (form.get("grant_type") === "authorization_code") {
        return {
          access_token: "at-1",
          refresh_token: "rt-1",
          id_token: idToken({ preferred_username: "me@outlook.example" }),
        };
      }
      refreshes++;
      return { access_token: `at-r${refreshes}`, refresh_token: `rt-r${refreshes}` };
    },
  });
  try {
    const channel = await oauthChannel(t, "microsoft-oauth");
    const state = new URL(
      ((await t.call("POST", `/channels/${channel.id}/oauth`)).body as { url: string }).url
    ).searchParams.get("state");
    await t.call("GET", `/oauth/callback?state=${state}&code=c`);
    const sent = (await t.call("POST", `/channels/${channel.id}/test`)).body as TestSendResult;
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.ok([...t.m.secrets.values()].includes("rt-r1"));
    const graph = providers.sent.find((s) => s.url === ENDPOINTS.microsoft.send)!;
    assert.equal(graph.headers["content-type"], "text/plain");
    assert.match(Buffer.from(graph.body, "base64").toString("utf8"), /From: me@outlook\.example/);

    // Changing the client drops the sign-in.
    await t.call("PUT", `/channels/${channel.id}`, {
      kind: "email",
      label: "Signed in",
      config: { email: { preset: "microsoft-oauth", clientId: "client-2", to: ["me@example.com"] } },
    });
    assert.equal([...t.m.secrets.values()].includes("rt-r1"), false);
    const view = ((await t.call("GET", "/channels")).body as ChannelView[])[0]!;
    assert.equal(view.config.email?.account, undefined);
    const after = (await t.call("POST", `/channels/${channel.id}/test`)).body as TestSendResult;
    assert.match(after.error ?? "", /signed in/);
  } finally {
    providers.restore();
    await t.close();
  }
});

test("a callback for someone else's sign-in, or a provider error, is refused", async () => {
  const t = await setup();
  const providers = stubProviders();
  try {
    const channel = await oauthChannel(t, "google-oauth");
    const state = new URL(
      ((await t.call("POST", `/channels/${channel.id}/oauth`)).body as { url: string }).url
    ).searchParams.get("state");
    const other: User = { ...mockAdmin, id: "someone-else" };
    t.m.setUser(other);
    const refused = await t.call("GET", `/oauth/callback?state=${state}&code=c`);
    assert.match(refused.location, /oauth=error/);
    assert.match(decodeURIComponent(refused.location), /someone\+else/);

    t.m.setUser(mockAdmin);
    const state2 = new URL(
      ((await t.call("POST", `/channels/${channel.id}/oauth`)).body as { url: string }).url
    ).searchParams.get("state");
    const denied = await t.call("GET", `/oauth/callback?state=${state2}&error=access_denied`);
    assert.match(denied.location, /oauth=error&message=access_denied/);
    assert.equal(providers.sent.length, 0);
  } finally {
    providers.restore();
    await t.close();
  }
});

test("sign in is refused without a public URL", async () => {
  const { createMockGate } = await import("../../../src/contracts/mocks/gate.js");
  const t = await setup({ services: { gate: createMockGate({ ready: false, signInUrl: "" }) } });
  try {
    const channel = await oauthChannel(t, "google-oauth");
    const setupView = (await t.call("GET", "/email/setup")).body as EmailSetupView;
    assert.equal(setupView.redirectUri, "");
    assert.ok(setupView.oauthBlocked);
    assert.equal((await t.call("POST", `/channels/${channel.id}/oauth`)).status, 409);
  } finally {
    await t.close();
  }
});

test("Microsoft 365 through the Entra connector sends as the From mailbox", async () => {
  const entra = createMockEntraMail();
  const t = await setup({ services: { entraMail: entra } });
  try {
    const created = await t.call("POST", "/channels", {
      kind: "email",
      label: "M365",
      config: { email: { preset: "entra", from: "alerts@example.com", to: ["ops@example.com"] } },
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = (created.body as ChannelView).id;
    assert.deepEqual((await t.call("POST", `/channels/${id}/test`)).body, { ok: true, status: 202 });
    assert.equal(entra.sent[0]!.from, "alerts@example.com");
    assert.match(entra.sent[0]!.message.subject, /Test notification/);

    entra.failWith = Object.assign(new Error("Sending mail answered 403: Access is denied."), { status: 403 });
    const refused = (await t.call("POST", `/channels/${id}/test`)).body as TestSendResult;
    assert.equal(refused.status, 403);
    assert.match(refused.error ?? "", /Access is denied/);

    const setupView = (await t.call("GET", "/email/setup")).body as EmailSetupView;
    assert.equal(setupView.entra.ready, true);
  } finally {
    await t.close();
  }
});

test("deleting an email channel removes its password and sign-in", async () => {
  const t = await setup();
  const providers = stubProviders({
    tokens: () => ({ access_token: "a", refresh_token: "rt-x", id_token: idToken({ email: "me@example.com" }) }),
  });
  try {
    const channel = await oauthChannel(t, "google-oauth");
    const state = new URL(
      ((await t.call("POST", `/channels/${channel.id}/oauth`)).body as { url: string }).url
    ).searchParams.get("state");
    await t.call("GET", `/oauth/callback?state=${state}&code=c`);
    assert.equal(t.m.secrets.size, 2);
    await t.call("DELETE", `/channels/${channel.id}`);
    assert.equal(t.m.secrets.size, 0);
  } finally {
    providers.restore();
    await t.close();
  }
});

test("mail bodies escape check text and link to the console", () => {
  const message = compose(
    {
      source: "Console",
      providerId: "checks",
      checkId: "web",
      label: "<script>x</script>",
      from: "ok",
      to: "crit",
      detail: "a & b",
      at: "2026-10-09T00:00:00Z",
    },
    ["ops@example.com"],
    "https://console.example.test"
  );
  assert.equal(message.subject, "[CRIT] <script>x</script>");
  assert.doesNotMatch(message.html, /<script>/);
  assert.match(message.html, /a &amp; b/);
  assert.match(message.text, /https:\/\/console\.example\.test/);
});

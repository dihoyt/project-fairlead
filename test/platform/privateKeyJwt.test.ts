// private_key_jwt client authentication: a key stored through services
// "signin" replaces the client secret, and the code is redeemed with a
// signed client assertion the provider can verify with the public key.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { SignInService } from "../../src/contracts/platform.js";
import { createPlatform } from "../../src/platform/index.js";
import { createSecrets } from "../../src/platform/secrets.js";
import { openDatabase } from "../../src/runtime/db.js";
import { createRuntime } from "../../src/runtime/index.js";
import { silentLogger } from "../../src/runtime/log.js";
import { boot, oidcSignIn, TEST_SECRETS_KEY, type FakeIssuer } from "./harness.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const CLIENT = "key-client";

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

interface KeyIssuer extends FakeIssuer {
  assertions: Array<{ header: Record<string, unknown>; payload: Record<string, unknown>; valid: boolean }>;
  forms: URLSearchParams[];
}

// Accepts only a client assertion signed with `publicKey`'s private half.
async function keyIssuer(methods?: string[]): Promise<KeyIssuer> {
  let issuer = "";
  let nonce = "";
  let claims: Record<string, unknown> = {};
  const assertions: KeyIssuer["assertions"] = [];
  const forms: URLSearchParams[] = [];
  const server: Server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/.well-known/openid-configuration") {
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          ...(methods ? { token_endpoint_auth_methods_supported: methods } : {}),
        })
      );
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        const form = new URLSearchParams(raw);
        forms.push(form);
        const [h, p, s] = (form.get("client_assertion") ?? "").split(".");
        const valid =
          !!h &&
          !!p &&
          !!s &&
          crypto.verify("sha256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"));
        if (h && p) {
          assertions.push({
            header: JSON.parse(Buffer.from(h, "base64url").toString()) as Record<string, unknown>,
            payload: JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>,
            valid,
          });
        }
        if (!valid || req.headers.authorization || form.get("client_secret")) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: "invalid_client" }));
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        res.end(
          JSON.stringify({
            id_token: `${part({ alg: "none" })}.${part({ iss: issuer, aud: CLIENT, exp: now + 300, iat: now, nonce, ...claims })}.`,
          })
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: issuer,
    assertions,
    forms,
    next: (value) => void (claims = value),
    setNonce: (value) => void (nonce = value),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function signInService(): Promise<{
  signIn: SignInService;
  close(): void;
  secrets: ReturnType<typeof createSecrets>;
}> {
  process.env.SECRETS_KEY = TEST_SECRETS_KEY;
  process.env.PUBLIC_ORIGIN = "https://console.example.test";
  const db = openDatabase(":memory:");
  const runtime = await createRuntime({ db, dataDir: "/tmp", modules: [], createPlatform, logFor: () => silentLogger });
  return {
    signIn: runtime.services.get("signin"),
    secrets: createSecrets(db, "default"),
    close: () => {
      delete process.env.PUBLIC_ORIGIN;
      db.close();
    },
  };
}

test("a client key replaces the secret, and a secret replaces the key", async () => {
  const { signIn, secrets, close } = await signInService();
  try {
    const base = { issuer: "https://login.example.test/t/v2.0", clientId: CLIENT };
    await signIn.setOidcClient({ ...base, clientSecret: "s3cret" }, "test");
    await signIn.setOidcClient({ ...base, clientKey: { privateKey: PRIVATE_PEM, keyId: "k1" } }, "test");
    let view = await signIn.oidc();
    assert.equal(view.hasKey, true);
    assert.equal(view.hasSecret, false);
    assert.match((await secrets.get("auth", "oidc-key")) ?? "", /BEGIN PRIVATE KEY/);

    await signIn.setOidcClient({ ...base, clientSecret: "again" }, "test");
    view = await signIn.oidc();
    assert.equal(view.hasKey, false);
    assert.equal(view.hasSecret, true);

    await assert.rejects(signIn.setOidcClient(base, "test"), /either a client secret or a client key/);
    await assert.rejects(
      signIn.setOidcClient({ ...base, clientSecret: "x", clientKey: { privateKey: PRIVATE_PEM } }, "test"),
      /either a client secret or a client key/
    );
    await assert.rejects(
      signIn.setOidcClient({ ...base, clientKey: { privateKey: "not a key" } }, "test"),
      /not valid PEM/
    );
    const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    await assert.rejects(
      signIn.setOidcClient(
        { ...base, clientKey: { privateKey: ec.export({ type: "pkcs8", format: "pem" }).toString() } },
        "test"
      ),
      /RSA/
    );
    assert.equal((await signIn.oidc()).hasSecret, true);
  } finally {
    close();
  }
});

for (const methods of [undefined, ["client_secret_basic", "private_key_jwt"]]) {
  test(`the code is redeemed with a signed assertion (methods ${methods ? "listed" : "unlisted"})`, async () => {
    const issuer = await keyIssuer(methods);
    const app = await boot();
    try {
      app.settings.set("auth.oidc.enabled", true, "test");
      app.settings.set("auth.oidc.issuer", issuer.url, "test");
      app.settings.set("auth.oidc.clientId", CLIENT, "test");
      app.settings.set("auth.oidc.autoProvision", true, "test");
      await createSecrets(app.db, "default").put(
        "auth",
        "oidc-key",
        JSON.stringify({ privateKey: PRIVATE_PEM, keyId: "k1" })
      );

      const { location } = await oidcSignIn(app, issuer, { sub: "u-1", preferred_username: "ann" });
      assert.doesNotMatch(location, /error/);
      assert.equal(issuer.assertions.length, 1);
      const [assertion] = issuer.assertions;
      assert.equal(assertion!.valid, true);
      assert.equal(assertion!.header.alg, "RS256");
      assert.equal(assertion!.header.kid, "k1");
      assert.equal(assertion!.payload.iss, CLIENT);
      assert.equal(assertion!.payload.sub, CLIENT);
      assert.equal(assertion!.payload.aud, `${issuer.url}/token`);
      assert.ok((assertion!.payload.exp as number) - (assertion!.payload.iat as number) <= 300);
      const form = issuer.forms[0]!;
      assert.equal(form.get("client_assertion_type"), "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
      assert.equal(form.get("client_id"), CLIENT);
      assert.equal(form.get("client_secret"), null);
    } finally {
      await app.close();
      await issuer.close();
    }
  });
}

test("a provider that does not list private_key_jwt is refused with the reason", async () => {
  const issuer = await keyIssuer(["client_secret_basic"]);
  const app = await boot();
  try {
    app.settings.set("auth.oidc.enabled", true, "test");
    app.settings.set("auth.oidc.issuer", issuer.url, "test");
    app.settings.set("auth.oidc.clientId", CLIENT, "test");
    await createSecrets(app.db, "default").put("auth", "oidc-key", JSON.stringify({ privateKey: PRIVATE_PEM }));
    const { location } = await oidcSignIn(app, issuer, { sub: "u-1" });
    assert.match(decodeURIComponent(location), /private_key_jwt/);
    assert.equal(issuer.forms.length, 0);
  } finally {
    await app.close();
    await issuer.close();
  }
});

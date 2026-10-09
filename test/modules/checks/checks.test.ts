import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckView } from "../../../src/contracts/checks.js";
import type { Events } from "../../../src/contracts/events.js";
import type { CheckResult } from "../../../src/contracts/health.js";
import { createMockContext, mockViewer } from "../../../src/contracts/mocks/context.js";
import { applyMigrations } from "../../../src/runtime/migrations.js";
import checks, { LATENCY_SERIES, createRunner } from "../../../src/modules/checks/index.js";
import {
  MAX_BODY_BYTES,
  judge,
  parseHostPort,
  probe,
  type CheckSpec,
  type ProbeOutcome,
} from "../../../src/modules/checks/probe.js";
import { createStore } from "../../../src/modules/checks/store.js";
import {
  ACCESS_LINK,
  gatedHost,
  ingressHostFor,
  metGate,
  rateGated,
  rateUnresolved,
  unresolved,
} from "../../../src/modules/checks/fallback.js";
import { createMockDeployService } from "../../../src/contracts/mocks/deploy.js";
import type { IngressHost } from "../../../src/contracts/catalog.js";
import { createMockCatalogService, mockDiscovery } from "../../../src/contracts/mocks/catalog.js";
import { migrations as healthMigrations } from "../../../src/modules/health/migrations.js";
import { startHealth } from "../../../src/modules/health/service.js";
import { listen } from "../../runtime/helpers.js";

// --- local targets ---------------------------------------------------------

let httpUrl = "";
let closedPort = 0;
let tcpPort = 0;
const servers: Array<{ close(cb?: () => void): unknown }> = [];

function serve(server: http.Server | https.Server | net.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

const handler: http.RequestListener = (req, res) => {
  if (req.url === "/slow") {
    setTimeout(() => res.end("late"), 2_000);
    return;
  }
  if (req.url === "/private") {
    if (req.headers["x-api-key"] !== "s3cret") {
      res.writeHead(401).end("who are you");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end('{"database": "ok"}');
    return;
  }
  if (req.url === "/large") {
    res.writeHead(200);
    res.write("x".repeat(MAX_BODY_BYTES + 10));
    res.end("needle");
    return;
  }
  if (req.url === "/redirect") {
    res.writeHead(302, { location: "/login" }).end();
    return;
  }
  const status = Number(/^\/status\/(\d{3})$/.exec(req.url ?? "")?.[1] ?? 200);
  res.writeHead(status, { "content-type": "text/plain", "set-cookie": "session=secret" }).end("hello");
};

// A throwaway CA and two leaf certificates (10 and 90 days) from openssl.
let ca = "";
let tlsDir = "";
const tlsUrls: Record<"short" | "long", string> = { short: "", long: "" };

function openssl(...args: string[]) {
  execFileSync("openssl", args, { cwd: tlsDir, stdio: "ignore" });
}

function leaf(name: string, days: number) {
  openssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.csr`,
    "-subj",
    "/CN=localhost"
  );
  openssl(
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    `${name}.pem`,
    "-days",
    String(days),
    "-extfile",
    "ext.cnf"
  );
  return { key: readFileSync(join(tlsDir, `${name}.key`)), cert: readFileSync(join(tlsDir, `${name}.pem`)) };
}

before(async () => {
  httpUrl = `http://127.0.0.1:${await serve(http.createServer(handler))}`;
  tcpPort = await serve(net.createServer((s) => s.end()));
  const spare = net.createServer();
  closedPort = await new Promise((resolve) =>
    spare.listen(0, "127.0.0.1", () => {
      const { port } = spare.address() as AddressInfo;
      spare.close(() => resolve(port));
    })
  );

  tlsDir = mkdtempSync(join(tmpdir(), "checks-tls-"));
  execFileSync("sh", ["-c", "printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\\n' > ext.cnf"], { cwd: tlsDir });
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "365",
    "-subj",
    "/CN=Test CA"
  );
  ca = readFileSync(join(tlsDir, "ca.pem"), "utf8");
  tlsUrls.short = `https://127.0.0.1:${await serve(https.createServer(leaf("short", 10), handler))}`;
  tlsUrls.long = `https://127.0.0.1:${await serve(https.createServer(leaf("long", 90), handler))}`;
});

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  rmSync(tlsDir, { recursive: true, force: true });
});

function spec(overrides: Partial<CheckSpec>): CheckSpec {
  return {
    id: "chk_test",
    label: "Test",
    kind: "http",
    target: `${httpUrl}/`,
    intervalMs: 60_000,
    timeoutMs: 1_000,
    insecureSkipVerify: false,
    tlsWarnDays: 21,
    enabled: true,
    ...overrides,
  } as CheckSpec;
}

const at = "2026-10-07T12:00:00.000Z";

async function check(overrides: Partial<CheckSpec>, options: { ca?: string } = {}): Promise<CheckResult> {
  const s = spec(overrides);
  return judge(s, await probe(s, options), at);
}

// --- probes ----------------------------------------------------------------

test("http: 200 is ok, with latency as the value and the target as the deep link", async () => {
  const r = await check({});
  assert.equal(r.status, "ok");
  assert.equal(typeof r.value, "number");
  assert.match(r.detail, /^200 in \d+ ms$/);
  assert.equal(r.deepLink, `${httpUrl}/`);
  assert.equal(r.raw, undefined);
});

test("http: a redirect counts as up by default and is not followed", async () => {
  const r = await check({ target: `${httpUrl}/redirect` });
  assert.equal(r.status, "ok");
  assert.match(r.detail, /^302 in/);
});

test("http: an unexpected status is crit and carries the raw response without cookies", async () => {
  const r = await check({ target: `${httpUrl}/status/503` });
  assert.equal(r.status, "crit");
  assert.match(r.detail, /^HTTP 503 in \d+ ms; expected 2xx or 3xx$/);
  const raw = r.raw as { httpStatus: number; headers: Record<string, string> };
  assert.equal(raw.httpStatus, 503);
  assert.equal(raw.headers["content-type"], "text/plain");
  assert.equal(raw.headers["set-cookie"], undefined);
});

test("http: a 401 or 403 from a reachable target is warn, up but login required", async () => {
  for (const code of [401, 403]) {
    const r = await check({ target: `${httpUrl}/status/${code}` });
    assert.equal(r.status, "warn");
    assert.match(r.detail, new RegExp(`^HTTP ${code} in \\d+ ms; up, login required`));
    assert.equal((r.raw as { httpStatus: number }).httpStatus, code);
  }
  // Once statuses are listed, an unlisted 401 is a plain mismatch again.
  assert.equal((await check({ target: `${httpUrl}/status/401`, expectStatus: [200] })).status, "crit");
});

test("http: expectStatus replaces the default set", async () => {
  assert.equal((await check({ target: `${httpUrl}/status/401`, expectStatus: [401] })).status, "ok");
  const r = await check({ target: `${httpUrl}/`, expectStatus: [204, 401] });
  assert.equal(r.status, "crit");
  assert.match(r.detail, /expected 204, 401$/);
});

test("http: a timeout is crit and says how long it waited", async () => {
  const r = await check({ target: `${httpUrl}/slow`, timeoutMs: 200 });
  assert.equal(r.status, "crit");
  assert.equal(r.detail, "timed out after 200 ms (ETIMEDOUT)");
});

test("http: connection refused is crit with the error code", async () => {
  const r = await check({ target: `http://127.0.0.1:${closedPort}/` });
  assert.equal(r.status, "crit");
  assert.match(r.detail, /ECONNREFUSED/);
  assert.equal((r.raw as { error: { code: string } }).error.code, "ECONNREFUSED");
});

test("https: certificate expiry is reported, and warns inside tlsWarnDays", async () => {
  const long = await check({ target: tlsUrls.long }, { ca });
  assert.equal(long.status, "ok");
  assert.match(long.detail, /^200 in \d+ ms; certificate valid (89|90) days$/);

  const short = await check({ target: tlsUrls.short }, { ca });
  assert.equal(short.status, "warn");
  assert.match(short.detail, /certificate valid (9|10) days$/);
  assert.equal((short.raw as { certificate: { subject: string } }).certificate.subject, "localhost");

  assert.equal((await check({ target: tlsUrls.short, tlsWarnDays: 0 }, { ca })).status, "ok");
  assert.equal((await check({ target: tlsUrls.short, tlsWarnDays: 45 }, { ca })).status, "crit");
});

test("https: an untrusted certificate is crit", async () => {
  const r = await check({ target: tlsUrls.long });
  assert.equal(r.status, "crit");
  assert.match(r.detail, /certificate/i);
});

const withCert = (daysLeft: number) => ({
  latencyMs: 5,
  httpStatus: 200,
  certificate: { subject: "example.test", issuer: "CA", validTo: "2026-10-01T00:00:00.000Z", daysLeft },
});

test("http: bodyMatch is a plain substring of the body", async () => {
  const ok = await check({ target: `${httpUrl}/`, bodyMatch: "hell" });
  assert.equal(ok.status, "ok");
  assert.match(ok.detail, /^200 in \d+ ms; body matched$/);

  const missing = await check({ target: `${httpUrl}/`, bodyMatch: "goodbye" });
  assert.equal(missing.status, "crit");
  assert.match(missing.detail, /; body does not contain "goodbye"$/);
  assert.equal((missing.raw as { bodyExcerpt: string }).bodyExcerpt, "hello");

  // Regex metacharacters are literal.
  assert.equal((await check({ target: `${httpUrl}/`, bodyMatch: "h.llo" })).status, "crit");
});

test("http: bodyMatch reads at most MAX_BODY_BYTES", async () => {
  const r = await check({ target: `${httpUrl}/large`, bodyMatch: "needle", timeoutMs: 5_000 });
  assert.equal(r.status, "crit");
  assert.match(r.detail, new RegExp(`the first ${MAX_BODY_BYTES} bytes of the body does not contain`));
  assert.equal((r.raw as { bodyExcerpt: string }).bodyExcerpt.length, 500);
});

test("http: the auth header carries the secret, which never appears in the result", async () => {
  const s = { target: `${httpUrl}/private`, authHeader: "X-API-Key", bodyMatch: '"database": "ok"' };
  const denied = await check(s);
  assert.equal(denied.status, "crit");
  assert.match(denied.detail, /^HTTP 401/);

  const spec2 = spec(s);
  const allowed = judge(spec2, await probe(spec2, { secret: "s3cret" }), at);
  assert.equal(allowed.status, "ok");
  assert.doesNotMatch(JSON.stringify(allowed), /s3cret/);
  const failed = judge(spec2, await probe({ ...spec2, bodyMatch: "nope" }, { secret: "s3cret" }), at);
  assert.doesNotMatch(JSON.stringify(failed), /s3cret/);
});

test("https: insecureSkipVerify accepts an untrusted certificate, still reports expiry, and says so", async () => {
  const r = await check({ target: tlsUrls.short, insecureSkipVerify: true });
  assert.equal(r.status, "warn");
  assert.match(r.detail, /certificate valid (9|10) days; certificate not verified \(insecureSkipVerify\)$/);
  const long = await check({ target: tlsUrls.long, insecureSkipVerify: true });
  assert.equal(long.status, "ok");
});

test("judge: expiry thresholds and an expired certificate", () => {
  const s = spec({ target: "https://example.test/", tlsWarnDays: 21 });
  assert.equal(judge(s, withCert(21), at).status, "ok");
  assert.equal(judge(s, withCert(20), at).status, "warn");
  assert.equal(judge(s, withCert(7), at).status, "warn");
  assert.equal(judge(s, withCert(6), at).status, "crit");
  const expired = judge(s, withCert(-3), at);
  assert.equal(expired.status, "crit");
  assert.match(expired.detail, /certificate expired 2026-10-01/);
  assert.equal(judge(s, withCert(1), at).detail, "200 in 5 ms; certificate valid 1 day");
});

test("tcp: connect is ok, refused is crit, and there is no deep link", async () => {
  const up = await check({ kind: "tcp", target: `127.0.0.1:${tcpPort}` });
  assert.equal(up.status, "ok");
  assert.match(up.detail, /^Connected in \d+ ms$/);
  assert.equal(up.deepLink, undefined);
  const down = await check({ kind: "tcp", target: `127.0.0.1:${closedPort}` });
  assert.equal(down.status, "crit");
  assert.match(down.detail, /ECONNREFUSED/);
});

test("parseHostPort accepts names, IPv4 and bracketed IPv6, and rejects the rest", () => {
  assert.deepEqual(parseHostPort("nas.lan:22"), { host: "nas.lan", port: 22 });
  assert.deepEqual(parseHostPort("10.0.0.5:5432"), { host: "10.0.0.5", port: 5432 });
  assert.deepEqual(parseHostPort("[::1]:443"), { host: "::1", port: 443 });
  for (const bad of ["nas.lan", "nas.lan:0", "nas.lan:70000", "::1:443", "http://x:80", "a b:1"]) {
    assert.equal(parseHostPort(bad), null, bad);
  }
});

// --- API -------------------------------------------------------------------

async function setupApi() {
  const m = createMockContext("checks", { migrations: checks.migrations ?? [] });
  await checks.register(m.ctx);
  const server = await listen(m.app);
  const call = async <T = unknown>(method: string, path: string, body?: unknown) => {
    const res = await fetch(`${server.url}/api/checks${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  return {
    m,
    call,
    close: async () => {
      await server.close();
      await m.close();
    },
  };
}

test("API: create applies defaults, lists, updates, runs and deletes, auditing each", async () => {
  const { m, call, close } = await setupApi();
  try {
    const created = await call<CheckView>("POST", "", { label: "Grafana", kind: "http", target: `${httpUrl}/` });
    assert.equal(created.status, 200);
    assert.match(created.body.id, /^chk_[0-9a-f]{16}$/);
    assert.deepEqual(
      { ...created.body, id: "" },
      {
        id: "",
        label: "Grafana",
        kind: "http",
        target: `${httpUrl}/`,
        intervalMs: 60_000,
        timeoutMs: 10_000,
        hasSecret: false,
        insecureSkipVerify: false,
        tlsWarnDays: 21,
        enabled: true,
      }
    );
    const id = created.body.id;

    const ran = await call<CheckResult>("POST", `/${id}/run`);
    assert.equal(ran.status, 200);
    assert.equal(ran.body.status, "ok");
    assert.equal(ran.body.id, id);

    const listed = await call<CheckView[]>("GET", "");
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0]!.last?.status, "ok");
    assert.ok(m.samples.some((s) => s.series === LATENCY_SERIES && s.labels.check === id && s.labels.kind === "http"));

    const same = await call<CheckView>("PUT", `/${id}`, {
      label: "Grafana UI",
      kind: "http",
      target: `${httpUrl}/`,
      expectStatus: [200, 200],
    });
    assert.equal(same.body.label, "Grafana UI");
    assert.deepEqual(same.body.expectStatus, [200]);
    assert.equal(same.body.last?.status, "ok", "an unchanged target keeps its last result");

    const moved = await call<CheckView>("PUT", `/${id}`, {
      label: "Grafana UI",
      kind: "tcp",
      target: `127.0.0.1:${tcpPort}`,
    });
    assert.equal(moved.body.kind, "tcp");
    assert.equal(moved.body.last, undefined, "a new target drops the old result");

    assert.deepEqual((await call("DELETE", `/${id}`)).body, { ok: true });
    assert.equal((await call("DELETE", `/${id}`)).status, 404);
    assert.equal((await call("POST", `/${id}/run`)).status, 404);
    assert.equal((await call("PUT", `/${id}`, { label: "x", kind: "tcp", target: "a:1" })).status, 404);

    assert.deepEqual(
      m.audit.map((a) => a.action),
      ["checks.create", "checks.run", "checks.update", "checks.update", "checks.delete"]
    );
  } finally {
    await close();
  }
});

test("API: rejects bad input", async () => {
  const { call, close } = await setupApi();
  try {
    const bad: Array<[unknown, RegExp]> = [
      [{ label: "", kind: "http", target: "https://x.test/" }, /label/],
      [{ label: "a", kind: "http", target: "ftp://x.test/" }, /target: Must be an http\(s\) URL/],
      [{ label: "a", kind: "http", target: "https://user:pw@x.test/" }, /username or password/],
      [{ label: "a", kind: "tcp", target: "x.test" }, /target: Must be host:port/],
      [{ label: "a", kind: "tcp", target: "x.test:22", expectStatus: [200] }, /expectStatus: Only for http/],
      [{ label: "a", kind: "http", target: "https://x.test/", intervalMs: 1000 }, /intervalMs/],
      [{ label: "a", kind: "http", target: "https://x.test/", timeoutMs: 60_000 }, /timeoutMs/],
      [{ label: "a", kind: "dns", target: "x.test" }, /kind/],
      [{ label: "a", kind: "tcp", target: "x.test:22", bodyMatch: "ok" }, /bodyMatch: Only for http/],
      [{ label: "a", kind: "tcp", target: "x.test:22", insecureSkipVerify: true }, /insecureSkipVerify: Only for http/],
      [{ label: "a", kind: "http", target: "https://x.test/", authHeader: "Bad Header", secret: "x" }, /authHeader/],
      [{ label: "a", kind: "http", target: "https://x.test/", authHeader: "X-Key", secret: "a\nb" }, /single line/],
      [{ label: "a", kind: "http", target: "https://x.test/", secret: "x" }, /needs authHeader/],
      [{ label: "a", kind: "http", target: "https://x.test/", authHeader: "X-Key" }, /needs a value/],
    ];
    for (const [body, message] of bad) {
      const res = await call<{ error: string }>("POST", "", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(JSON.stringify(res.body), message);
    }
  } finally {
    await close();
  }
});

test("API: the auth secret is write-only, kept on update unless replaced or cleared, and removed with the check", async () => {
  const { m, call, close } = await setupApi();
  try {
    const base = { label: "Private", kind: "http", target: `${httpUrl}/private`, authHeader: "X-API-Key" };
    const created = await call<CheckView>("POST", "", { ...base, secret: "s3cret", bodyMatch: '"database": "ok"' });
    assert.equal(created.status, 200);
    assert.equal(created.body.hasSecret, true);
    assert.equal(created.body.authHeader, "X-API-Key");
    assert.equal(created.body.bodyMatch, '"database": "ok"');
    const id = created.body.id;
    assert.equal(m.secrets.get(`checks/${id}`), "s3cret");

    const ran = await call<CheckResult>("POST", `/${id}/run`);
    assert.equal(ran.body.status, "ok");

    const list = await call<CheckView[]>("GET", "");
    assert.doesNotMatch(JSON.stringify(list.body), /s3cret/);

    const kept = await call<CheckView>("PUT", `/${id}`, base);
    assert.equal(kept.body.hasSecret, true);
    assert.equal(kept.body.bodyMatch, undefined);
    assert.equal(m.secrets.get(`checks/${id}`), "s3cret");

    await call("PUT", `/${id}`, { ...base, secret: "n3w" });
    assert.equal(m.secrets.get(`checks/${id}`), "n3w");

    const noHeader = await call<CheckView>("PUT", `/${id}`, {
      label: "Private",
      kind: "http",
      target: `${httpUrl}/private`,
    });
    assert.equal(noHeader.body.hasSecret, false);
    assert.equal(noHeader.body.authHeader, undefined);
    assert.equal(m.secrets.has(`checks/${id}`), false);

    assert.equal((await call("PUT", `/${id}`, base)).status, 400, "authHeader with nothing stored");
    await call("PUT", `/${id}`, { ...base, secret: "s3cret" });
    assert.equal(
      (await call("PUT", `/${id}`, { ...base, secret: "" })).status,
      400,
      "clearing needs the header gone too"
    );

    await call("DELETE", `/${id}`);
    assert.equal(m.secrets.has(`checks/${id}`), false);
    assert.ok(m.audit.every((a) => !JSON.stringify(a).includes("s3cret")));
  } finally {
    await close();
  }
});

test("API: a viewer can list but not change or run checks", async () => {
  const { m, call, close } = await setupApi();
  try {
    const { body } = await call<CheckView>("POST", "", { label: "a", kind: "tcp", target: `127.0.0.1:${tcpPort}` });
    m.setUser(mockViewer);
    assert.equal((await call("GET", "")).status, 200);
    assert.equal((await call("POST", "", { label: "b", kind: "tcp", target: "x:1" })).status, 403);
    assert.equal((await call("PUT", `/${body.id}`, { label: "b", kind: "tcp", target: "x:1" })).status, 403);
    assert.equal((await call("POST", `/${body.id}/run`)).status, 403);
    assert.equal((await call("DELETE", `/${body.id}`)).status, 403);
  } finally {
    await close();
  }
});

// --- provider --------------------------------------------------------------

test("provider: registers in the checks category and runs only due checks", async () => {
  const m = createMockContext("checks", { migrations: checks.migrations ?? [] });
  try {
    await checks.register(m.ctx);
    const [provider] = m.ctx.health.list();
    assert.equal(provider?.id, "checks");
    assert.equal(provider.category, "checks");

    let clock = Date.parse(at);
    const store = createStore(m.ctx.db, m.ctx.orgId);
    const runner = createRunner(m.ctx, store, () => clock);
    store.insert(
      "chk_a",
      {
        label: "A",
        kind: "tcp",
        target: `127.0.0.1:${tcpPort}`,
        intervalMs: 60_000,
        timeoutMs: 1_000,
        insecureSkipVerify: false,
        tlsWarnDays: 21,
        enabled: true,
      },
      at
    );
    store.insert(
      "chk_off",
      {
        label: "Off",
        kind: "tcp",
        target: `127.0.0.1:${closedPort}`,
        intervalMs: 60_000,
        timeoutMs: 1_000,
        insecureSkipVerify: false,
        tlsWarnDays: 21,
        enabled: false,
      },
      at
    );

    const first = await runner.collect();
    assert.deepEqual(
      first.map((r) => [r.id, r.status]),
      [
        ["chk_a", "ok"],
        ["chk_off", "absent"],
      ]
    );
    assert.equal(m.samples.length, 1);

    clock += 30_000;
    const cached = await runner.collect();
    assert.equal(cached[0]!.observedAt, first[0]!.observedAt, "not due: the last result is returned");
    assert.equal(m.samples.length, 1);

    clock += 30_000;
    await runner.collect();
    assert.equal(m.samples.length, 2, "due again after its interval");
  } finally {
    await m.close();
  }
});

test("a target going down turns the checks tile red and emits one health change", async () => {
  // The health module's own context, with this module's table beside it and
  // the same provider register() adds.
  const m = createMockContext("health", { migrations: healthMigrations });
  try {
    applyMigrations(m.ctx.db, "checks", checks.migrations ?? []);
    // Another pod holds the scheduling lease, so only the runs forced here happen.
    m.ctx.db
      .prepare(
        "INSERT INTO health_leases (org_id, name, holder, expires_at) VALUES (?, 'health.scheduler', 'elsewhere', ?)"
      )
      .run(m.ctx.orgId, Date.now() + 3_600_000);
    const health = startHealth(m.ctx);
    const changes: Array<Events["health.changed"]> = [];
    m.ctx.bus.on("health.changed", (c) => void changes.push(c));
    const store = createStore(m.ctx.db, m.ctx.orgId);
    const runner = createRunner(m.ctx, store);
    m.ctx.health.addProvider({
      id: "checks",
      category: "checks",
      label: "Checks",
      intervalMs: 15_000,
      collect: runner.collect,
    });

    const target = net.createServer((s) => s.end());
    const port: number = await new Promise((resolve) =>
      target.listen(0, "127.0.0.1", () => resolve((target.address() as AddressInfo).port))
    );
    store.insert(
      "chk_db",
      {
        label: "Database",
        kind: "tcp",
        target: `127.0.0.1:${port}`,
        intervalMs: 60_000,
        timeoutMs: 1_000,
        insecureSkipVerify: false,
        tlsWarnDays: 21,
        enabled: true,
      },
      at
    );

    await health.run("checks", { force: true });
    assert.equal(health.board().tiles.find((t) => t.category === "checks")?.status, "ok");

    await new Promise<void>((resolve) => target.close(() => resolve()));
    // Force the check due again rather than waiting out its interval.
    m.ctx.db.prepare("UPDATE checks_targets SET last_run_at = 0").run();
    await health.run("checks", { force: true });
    await new Promise((resolve) => setImmediate(resolve));

    const tile = health.board().tiles.find((t) => t.category === "checks");
    assert.equal(tile?.status, "crit");
    assert.equal(tile?.worst?.id, "chk_db");
    const toCrit = changes.filter((c) => c.checkId === "chk_db" && c.to === "crit");
    assert.equal(toCrit.length, 1);
  } finally {
    await m.close();
  }
});

// --- a hostname with no DNS yet ---------------------------------------------

const noDns = { error: { message: "getaddrinfo ENOTFOUND git.example.test", code: "ENOTFOUND" } };
const gitCheck = (path = "/"): CheckSpec => ({
  id: "chk_git",
  label: "Gitea",
  kind: "http",
  target: `https://git.example.test${path}`,
  intervalMs: 60_000,
  timeoutMs: 2_000,
  tlsWarnDays: 14,
  enabled: true,
});
const gitHost = (serviceUrl: string, ingressClass = "traefik"): IngressHost => ({
  host: "git.example.test",
  url: "https://git.example.test",
  tls: true,
  namespace: "gitea",
  ingress: "gitea",
  service: "gitea-http",
  serviceUrl,
  ingressClass,
  appId: "gitea",
});

test("no DNS: only a lookup failure on an http check falls back", () => {
  assert.equal(unresolved(gitCheck(), noDns), true);
  assert.equal(unresolved(gitCheck(), { error: { message: "x", code: "EAI_AGAIN" } }), true);
  assert.equal(unresolved(gitCheck(), { error: { message: "refused", code: "ECONNREFUSED" } }), false);
  assert.equal(unresolved({ ...gitCheck(), kind: "tcp", target: "git.example.test:22" }, noDns), false);
});

test("no DNS: the check's host is matched to an Ingress host with a Service URL", async () => {
  const catalog = createMockCatalogService({
    discovery: {
      ...mockDiscovery,
      ingressHosts: [gitHost(httpUrl), { ...gitHost(""), host: "bare.example.test", serviceUrl: undefined }],
    },
  });
  assert.equal((await ingressHostFor(catalog, "https://GIT.example.test/x"))?.service, "gitea-http");
  assert.equal(await ingressHostFor(catalog, "https://bare.example.test/"), undefined);
  assert.equal(await ingressHostFor(undefined, "https://git.example.test/"), undefined);
});

test("no DNS: up inside the cluster is a warning that links to the Access step", async () => {
  const { result, inside } = await rateUnresolved(gitCheck("/status/200?x=1"), noDns, gitHost(httpUrl), "now");
  assert.equal(result.status, "warn");
  assert.match(
    result.detail,
    /^Unreachable: git\.example\.test has no DNS record yet\. The app is up inside the cluster \(200 in \d+ ms\)/
  );
  assert.equal(result.deepLink, ACCESS_LINK);
  assert.equal(inside.httpStatus, 200);
});

test("no DNS: down inside the cluster too is critical", async () => {
  const { result } = await rateUnresolved(gitCheck("/status/500"), noDns, gitHost(httpUrl), "now");
  assert.equal(result.status, "crit");
  assert.match(result.detail, /does not answer inside the cluster either .*HTTP 500/);
  const refused = await rateUnresolved(gitCheck(), noDns, gitHost(`http://127.0.0.1:${closedPort}`), "now");
  assert.equal(refused.result.status, "crit");
});

test("no DNS on a Tailscale host: the Service is the whole answer", async () => {
  const { result } = await rateUnresolved(gitCheck(), noDns, gitHost(httpUrl, "tailscale"), "now");
  assert.equal(result.status, "ok");
  assert.match(result.detail, /answers on your tailnet only/);
  assert.equal(result.deepLink, "https://git.example.test/");
});

const gateWall: ProbeOutcome = { httpStatus: 401, latencyMs: 3, headers: { "content-type": "text/plain" } };

test("sign-in gate: only a bare 401 on an http check counts as meeting it", () => {
  assert.equal(metGate(gitCheck(), gateWall), true);
  assert.equal(metGate(gitCheck(), { ...gateWall, httpStatus: 403 }), false);
  assert.equal(metGate({ ...gitCheck(), authHeader: "Authorization" }, gateWall), false);
  assert.equal(metGate({ ...gitCheck(), expectStatus: [401] }, gateWall), false);
});

test("sign-in gate: a host is gated when the deploy service says so", async () => {
  const deploy = createMockDeployService();
  assert.equal(await gatedHost(deploy, "https://GIT.example.test/x"), true);
  assert.equal(await gatedHost(deploy, "https://longhorn.example.test/"), false);
  assert.equal(await gatedHost(undefined, "https://git.example.test/"), false);
});

test("sign-in gate: up inside the cluster is ok, down is critical", async () => {
  const up = await rateGated(gitCheck("/status/200"), gateWall, gitHost(httpUrl), "now");
  assert.equal(up.status, "ok");
  assert.match(up.detail, /^Behind the console's sign-in: .*HTTP 401 in 3 ms.*up inside the cluster \(200 in \d+ ms\)/);
  const down = await rateGated(gitCheck("/status/500"), gateWall, gitHost(httpUrl), "now");
  assert.equal(down.status, "crit");
  assert.match(down.detail, /does not answer inside the cluster/);
  const unknown = await rateGated(gitCheck(), gateWall, undefined, "now");
  assert.equal(unknown.status, "ok");
});

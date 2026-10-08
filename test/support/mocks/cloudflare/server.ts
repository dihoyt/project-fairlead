// An in-memory Cloudflare v4 API covering every call the Cloudflare connector
// makes, with the response envelope and field names of the real API
// (https://developers.cloudflare.com/api/). Tests drive it over HTTP and
// inspect or change `state` directly to simulate out-of-band edits.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { type Request, type Response } from "express";

export interface MockDnsRecord {
  id: string;
  zone_id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  comment: string | null;
}

export interface MockTunnel {
  id: string;
  account_tag: string;
  name: string;
  status: "inactive" | "healthy" | "degraded" | "down";
  config_src: "cloudflare" | "local";
  deleted_at: string | null;
  config: { ingress?: Array<{ hostname?: string; service: string; path?: string }> } | null;
  token: string;
}

export interface MockAccessApp {
  id: string;
  account: string;
  name: string;
  domain: string;
  type: string;
  session_duration: string;
  policies: Array<{ id: string; name: string; decision: string; include: unknown[]; precedence?: number }>;
}

export interface MockToken {
  status: "active" | "disabled" | "expired";
  // Scopes the token holds: "dns", "tunnel", "access". Omitted: all.
  scopes?: Array<"dns" | "tunnel" | "access">;
  // Account-owned tokens verify only under /accounts/:id/tokens/verify.
  account?: string;
}

export interface CloudflareState {
  tokens: Map<string, MockToken>;
  accounts: Array<{ id: string; name: string }>;
  zones: Array<{ id: string; name: string; account: { id: string; name: string } }>;
  dns: MockDnsRecord[];
  tunnels: MockTunnel[];
  accessApps: MockAccessApp[];
  // Every request, "METHOD /path", for asserting what was (not) called.
  log: string[];
}

export const MOCK_TOKEN = "cf-test-token";
export const MOCK_ACCOUNT = "0123456789abcdef0123456789abcdef";
export const MOCK_ZONE = "example.test";

export function mockCloudflareState(): CloudflareState {
  return {
    tokens: new Map([[MOCK_TOKEN, { status: "active" }]]),
    accounts: [{ id: MOCK_ACCOUNT, name: "Example account" }],
    zones: [{ id: "zone-1", name: MOCK_ZONE, account: { id: MOCK_ACCOUNT, name: "Example account" } }],
    dns: [],
    tunnels: [],
    accessApps: [],
    log: [],
  };
}

const ok = (res: Response, result: unknown, info?: Record<string, number>) =>
  res.json({ success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) });

const fail = (res: Response, status: number, code: number, message: string) =>
  res.status(status).json({ success: false, errors: [{ code, message }], messages: [], result: null });

function page<T>(req: Request, res: Response, items: T[]) {
  const per = Math.min(Number(req.query.per_page ?? 20) || 20, 100);
  const pageNo = Math.max(Number(req.query.page ?? 1) || 1, 1);
  const slice = items.slice((pageNo - 1) * per, pageNo * per);
  ok(res, slice, {
    page: pageNo,
    per_page: per,
    count: slice.length,
    total_count: items.length,
    total_pages: Math.max(1, Math.ceil(items.length / per)),
  });
}

const scoped = (scope: "dns" | "tunnel" | "access") => (_req: Request, res: Response, next: () => void) => {
  const token = res.locals.token as MockToken;
  if (token.scopes && !token.scopes.includes(scope)) return fail(res, 403, 10000, "Authentication error");
  next();
};

const dnsBody = (req: Request) => {
  const b = req.body as Partial<MockDnsRecord>;
  return {
    type: String(b.type),
    name: String(b.name),
    content: String(b.content),
    proxied: Boolean(b.proxied),
    ttl: Number(b.ttl ?? 1),
    comment: b.comment ?? null,
  };
};
const tunnelView = ({ config: _config, token: _token, ...t }: MockTunnel) => t;
const appBody = (req: Request, id: string, accountId: string): MockAccessApp => {
  const b = req.body as Partial<MockAccessApp> & { policies?: Array<Partial<MockAccessApp["policies"][number]>> };
  return {
    id,
    account: accountId,
    name: String(b.name),
    domain: String(b.domain),
    type: String(b.type ?? "self_hosted"),
    session_duration: String(b.session_duration ?? "24h"),
    policies: (b.policies ?? []).map((p, i) => ({
      id: `pol-${id}-${i}`,
      name: String(p.name),
      decision: String(p.decision),
      include: p.include ?? [],
      precedence: p.precedence ?? i + 1,
    })),
  };
};
export async function startMockCloudflare(state: CloudflareState = mockCloudflareState()) {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    state.log.push(`${req.method} ${req.path}`);
    const header = req.get("authorization") ?? "";
    const token = state.tokens.get(header.replace(/^Bearer /, ""));
    if (!token) return fail(res, 400, 6003, "Invalid request headers");
    res.locals.token = token;
    next();
  });

  const account = (req: Request, res: Response, next: () => void) => {
    if (!state.accounts.some((a) => a.id === req.params.account))
      return fail(res, 403, 9109, "Unauthorized to access requested resource");
    next();
  };

  app.get("/user/tokens/verify", (_req, res) => {
    const token = res.locals.token as MockToken;
    if (token.account) return fail(res, 401, 1000, "Invalid API Token");
    ok(res, { id: "tok_1", status: token.status });
  });
  app.get("/accounts/:account/tokens/verify", account, (_req, res) => {
    const token = res.locals.token as MockToken;
    ok(res, { id: "tok_1", status: token.status });
  });

  app.get("/accounts", (req, res) => page(req, res, state.accounts));
  app.get("/accounts/:account", account, (req, res) =>
    ok(
      res,
      state.accounts.find((a) => a.id === req.params.account)
    )
  );

  app.get("/zones", (req, res) => {
    const accountId = req.query["account.id"];
    const name = req.query.name;
    page(
      req,
      res,
      state.zones.filter((z) => (!accountId || z.account.id === accountId) && (!name || z.name === name))
    );
  });

  // --- DNS ---
  const zone = (req: Request, res: Response, next: () => void) => {
    if (!state.zones.some((z) => z.id === req.params.zone)) return fail(res, 404, 7003, "Could not route to /zones");
    next();
  };
  app.get("/zones/:zone/dns_records", scoped("dns"), zone, (req, res) => {
    const name = req.query.name;
    page(
      req,
      res,
      state.dns.filter((r) => r.zone_id === req.params.zone && (!name || r.name === name))
    );
  });
  app.post("/zones/:zone/dns_records", scoped("dns"), zone, (req, res) => {
    const body = dnsBody(req);
    const clash = state.dns.find(
      (r) => r.zone_id === req.params.zone && r.name === body.name && (r.type === "CNAME" || body.type === "CNAME")
    );
    if (clash) return fail(res, 400, 81053, "An A, AAAA, or CNAME record with that host already exists.");
    const record: MockDnsRecord = { id: `rec-${randomUUID().slice(0, 8)}`, zone_id: req.params.zone!, ...body };
    state.dns.push(record);
    ok(res, record);
  });
  app.put("/zones/:zone/dns_records/:id", scoped("dns"), zone, (req, res) => {
    const record = state.dns.find((r) => r.id === req.params.id && r.zone_id === req.params.zone);
    if (!record) return fail(res, 404, 81044, "Record does not exist.");
    Object.assign(record, dnsBody(req));
    ok(res, record);
  });
  app.delete("/zones/:zone/dns_records/:id", scoped("dns"), zone, (req, res) => {
    const index = state.dns.findIndex((r) => r.id === req.params.id && r.zone_id === req.params.zone);
    if (index < 0) return fail(res, 404, 81044, "Record does not exist.");
    state.dns.splice(index, 1);
    ok(res, { id: req.params.id });
  });

  // --- tunnels ---
  const tunnel = (req: Request, res: Response) => {
    const found = state.tunnels.find(
      (t) => t.id === req.params.tunnel && t.account_tag === req.params.account && !t.deleted_at
    );
    if (!found) fail(res, 404, 1003, "Tunnel not found");
    return found;
  };
  app.get("/accounts/:account/cfd_tunnel", scoped("tunnel"), account, (req, res) => {
    page(
      req,
      res,
      state.tunnels
        .filter((t) => t.account_tag === req.params.account && (req.query.is_deleted !== "false" || !t.deleted_at))
        .map(tunnelView)
    );
  });
  app.post("/accounts/:account/cfd_tunnel", scoped("tunnel"), account, (req, res) => {
    const body = req.body as { name?: string; config_src?: string };
    if (!body.name) return fail(res, 400, 1001, "name is required");
    if (state.tunnels.some((t) => t.name === body.name && !t.deleted_at)) {
      return fail(res, 409, 1013, "You already have a tunnel with this name");
    }
    const created: MockTunnel = {
      id: randomUUID(),
      account_tag: req.params.account!,
      name: body.name,
      status: "inactive",
      config_src: body.config_src === "cloudflare" ? "cloudflare" : "local",
      deleted_at: null,
      config: null,
      token: `eyJ-${randomUUID()}`,
    };
    state.tunnels.push(created);
    ok(res, { ...tunnelView(created), token: created.token });
  });
  app.get("/accounts/:account/cfd_tunnel/:tunnel", scoped("tunnel"), account, (req, res) => {
    const found = tunnel(req, res);
    if (found) ok(res, tunnelView(found));
  });
  app.get("/accounts/:account/cfd_tunnel/:tunnel/token", scoped("tunnel"), account, (req, res) => {
    const found = tunnel(req, res);
    if (found) ok(res, found.token);
  });
  app.get("/accounts/:account/cfd_tunnel/:tunnel/configurations", scoped("tunnel"), account, (req, res) => {
    const found = tunnel(req, res);
    if (found) ok(res, { tunnel_id: found.id, version: 1, config: found.config, source: found.config_src });
  });
  app.put("/accounts/:account/cfd_tunnel/:tunnel/configurations", scoped("tunnel"), account, (req, res) => {
    const found = tunnel(req, res);
    if (!found) return;
    if (found.config_src !== "cloudflare") return fail(res, 400, 1056, "Tunnel is locally configured");
    const config = (req.body as { config?: MockTunnel["config"] }).config ?? null;
    const ingress = config?.ingress ?? [];
    if (ingress.length > 0 && ingress.at(-1)!.hostname) {
      return fail(
        res,
        400,
        1055,
        "The last ingress rule must match all URLs (i.e. it should not have a hostname or path)"
      );
    }
    found.config = config;
    ok(res, { tunnel_id: found.id, version: 2, config, source: "cloudflare" });
  });

  // --- Access ---
  app.get("/accounts/:account/access/apps", scoped("access"), account, (req, res) =>
    page(
      req,
      res,
      state.accessApps.filter((a) => a.account === req.params.account)
    )
  );
  app.post("/accounts/:account/access/apps", scoped("access"), account, (req, res) => {
    const created = appBody(req, randomUUID(), req.params.account!);
    if (state.accessApps.some((a) => a.domain === created.domain)) {
      return fail(res, 400, 12130, "access.api.error.conflict: application already exists");
    }
    state.accessApps.push(created);
    ok(res, created);
  });
  app.put("/accounts/:account/access/apps/:id", scoped("access"), account, (req, res) => {
    const index = state.accessApps.findIndex((a) => a.id === req.params.id);
    if (index < 0) return fail(res, 404, 12001, "access.api.error.not_found");
    state.accessApps[index] = appBody(req, req.params.id!, req.params.account!);
    ok(res, state.accessApps[index]);
  });
  app.delete("/accounts/:account/access/apps/:id", scoped("access"), account, (req, res) => {
    const index = state.accessApps.findIndex((a) => a.id === req.params.id);
    if (index < 0) return fail(res, 404, 12001, "access.api.error.not_found");
    state.accessApps.splice(index, 1);
    ok(res, { id: req.params.id });
  });

  app.use((_req, res) => fail(res, 404, 7003, "No route for that URI"));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return {
    state,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

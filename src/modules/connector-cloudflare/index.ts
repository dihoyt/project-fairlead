import { z } from "zod";
import type { Request } from "express";
import type {
  CloudflareAccessPolicy,
  CloudflareDiscovery,
  CloudflareTunnelView,
  CloudflareView,
  ConnectorInstance,
  ConnectorKind,
  ConnectorValues,
} from "../../contracts/connectors.js";
import type { CheckResult } from "../../contracts/health.js";
import type { Module, ModuleContext } from "../../contracts/module.js";
import type { DriftReport } from "../../contracts/ownership.js";
import { ownerMarkers, product } from "../../product.js";
import { HttpError } from "../../runtime/http.js";
import { CloudflareClient, CloudflareError, DEFAULT_API_BASE, type Tunnel } from "./api.js";
import { migrations } from "./migrations.js";
import { CloudflareStore } from "./store.js";
import { directTls, removeAllTls } from "./direct.js";
import { DEFAULT_ADDRESS_LOOKUP, detectPublicAddress, lookupUrls } from "./address.js";
import { cleanup, parseAllow, sync, type Marker } from "./sync.js";

const KIND = "cloudflare";

const flagged = (get: () => { noLogin?: boolean } | undefined): boolean => {
  try {
    return get()?.noLogin === true;
  } catch {
    return false;
  }
};
const SYNC_DEBOUNCE_MS = 5_000;
// Settings carry no change event; the Access setting is looked at this often.
const SETTING_POLL_MS = 30_000;
// How often a detected public address is checked between reconciles.
const ADDRESS_POLL_MS = 2 * 60_000;
const TUNNEL_SUFFIX = ".cfargotunnel.com";

// A wildcard record that sends the zone to another tunnel answers for every
// host the connector hasn't published yet, with error 1033 once that
// tunnel has no cloudflared.
export async function wildcardWarnings(
  api: CloudflareClient,
  accountId: string,
  zone: { id: string; name: string },
  tunnelId: string | undefined
): Promise<string[]> {
  const name = `*.${zone.name}`;
  const records = (await api.dnsRecords(zone.id, name)).filter((r) => r.name === name);
  const warnings: string[] = [];
  for (const record of records) {
    const target = record.content.toLowerCase();
    const other = target.endsWith(TUNNEL_SUFFIX) ? target.slice(0, -TUNNEL_SUFFIX.length) : undefined;
    if (!other || other === tunnelId?.toLowerCase()) continue;
    const tunnel = await api.tunnel(accountId, other).catch(() => undefined);
    const label = tunnel ? `tunnel "${tunnel.name}" (${tunnel.status})` : `tunnel ${other}`;
    warnings.push(
      `${name} points at ${label}, not this connector's tunnel: apps without their own record go there. ` +
        "Delete that record in Cloudflare's DNS, or point it at this tunnel."
    );
  }
  return warnings;
}

export const marker: Marker = {
  tag: product.ownerMarker.externalTag,
  prefix: product.ownerMarker.externalPrefix,
  ownsComment: (comment) => ownerMarkers.some((m) => (comment ?? "").includes(m.externalTag)),
  ownsName: (name) => ownerMarkers.some((m) => name.startsWith(m.externalPrefix)),
};

const FIELDS: ConnectorKind["fields"] = [
  {
    key: "apiToken",
    label: "API token",
    type: "secret",
    required: true,
    help: "Account > Cloudflare Tunnel > Edit, Zone > DNS > Edit, and Account > Access: Apps and Policies > Edit if you want Access apps.",
  },
  { key: "accountId", label: "Account ID", type: "text", required: true },
  { key: "zone", label: "Zone", type: "text", required: true, placeholder: "example.com" },
  {
    key: "tunnelId",
    label: "Tunnel ID",
    type: "text",
    required: false,
    help: "The tunnel cloudflared runs. Empty: pick or create one from the Cloudflare page.",
  },
  {
    key: "publicAddress",
    label: "Public address (leave empty to detect)",
    type: "text",
    required: false,
    help: "Where DNS-only records for direct apps point: your router's public IP. Empty: looked up at every sync and the records follow it when it changes.",
  },
  {
    key: "accessEmails",
    label: "Access allow list",
    type: "text",
    required: false,
    help: "Emails or @domains Cloudflare Access lets in, comma separated.",
    placeholder: "you@example.com, @example.com",
  },
];

const hostRequest = z.object({
  exposure: z.enum(["tunnel", "direct"]).optional(),
  access: z.boolean().optional(),
});
const discoverRequest = z.object({ token: z.string().trim().min(1).max(512) });
const tunnelRequest = z.object({
  tunnelId: z
    .string()
    .trim()
    .regex(/^[0-9a-f-]{36}$/i, "Not a tunnel ID.")
    .optional(),
  name: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,64}$/, "Letters, digits, . _ and -, up to 64.")
    .optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

const now = () => new Date().toISOString();
const check = (id: string, label: string, status: CheckResult["status"], detail: string, raw?: unknown) => ({
  id,
  label,
  status,
  detail,
  observedAt: now(),
  ...(raw === undefined ? {} : { raw }),
});

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function register(ctx: ModuleContext): void {
  const store = new CloudflareStore(ctx.db, ctx.orgId);
  const accessApps = ctx.settings.declare<CloudflareAccessPolicy>({
    key: "connector-cloudflare.accessApps",
    label: "Cloudflare Access apps",
    help: "Put Cloudflare Access in front of app hostnames: never, always, or per app on the Cloudflare page.",
    schema: z.enum(["never", "always", "per-app"]),
    default: "never",
    env: "CLOUDFLARE_ACCESS_APPS",
  });
  const apiBase = ctx.settings.declare({
    key: "connector-cloudflare.apiBase",
    label: "Cloudflare API base URL",
    schema: z.string().url(),
    default: DEFAULT_API_BASE,
    env: "CLOUDFLARE_API_BASE",
    envOnly: true,
  });

  const addressLookup = ctx.settings.declare({
    key: "connector-cloudflare.addressLookup",
    label: "Public address lookup",
    help: "URLs that answer with the caller's IP, tried in order, for a connector whose Public address is empty.",
    schema: z.string(),
    default: DEFAULT_ADDRESS_LOOKUP,
    env: "PUBLIC_ADDRESS_LOOKUP",
    envOnly: true,
  });
  const detect = (signal?: AbortSignal) => detectPublicAddress(lookupUrls(addressLookup.get()), signal);

  const client = (token: string, signal?: AbortSignal) => new CloudflareClient(token, apiBase.get(), signal);
  // Catalog apps and template instances alike; a missing service means no
  // flag rather than a failed sync.
  const noLogin = (appId: string): boolean =>
    flagged(() => ctx.services.get("catalog").get(appId)) ||
    flagged(() =>
      ctx.services
        .get("templates")
        .entries()
        .find((e) => e.id === appId)
    );
  const tunnelIdOf = (instance: ConnectorInstance) => instance.config.tunnelId || store.tunnel()?.id;

  async function verify(values: ConnectorValues, signal: AbortSignal, tunnelId?: string): Promise<CheckResult[]> {
    const api = client(values.apiToken ?? "", signal);
    const results: CheckResult[] = [];
    try {
      const token = await api.verifyToken(values.accountId);
      if (token.status !== "active") {
        return [check("token", "API token", "crit", `The token is ${token.status}`, token)];
      }
      results.push(check("token", "API token", "ok", "Token is active"));
    } catch (err) {
      return [check("token", "API token", "crit", message(err), { error: message(err) })];
    }
    const accountId = values.accountId ?? "";
    try {
      const account = await api.account(accountId);
      results.push(check("account", "Account", "ok", `Account "${account.name}"`));
    } catch (err) {
      // Reading the account needs Account Settings, which nothing else
      // does: a zone on the account proves the token reaches it.
      const viaZone =
        err instanceof CloudflareError && err.missingPermission
          ? (await api.zones(accountId).catch(() => []))[0]
          : undefined;
      if (!viaZone) {
        results.push(check("account", "Account", "crit", message(err), { error: message(err) }));
        return results;
      }
      const name = viaZone.account.name ? `"${viaZone.account.name}"` : accountId;
      results.push(check("account", "Account", "ok", `Account ${name} (seen through zone ${viaZone.name})`));
    }
    try {
      const zones = await api.zones(accountId, values.zone);
      const zone = zones[0];
      if (!zone) {
        results.push(check("zone", "Zone", "crit", `${values.zone} isn't on this account, or the token can't see it`));
      } else {
        await api.dnsRecords(zone.id, values.zone);
        results.push(check("zone", "Zone", "ok", `${zone.name} is on this account; DNS records can be read`));
      }
    } catch (err) {
      results.push(check("zone", "Zone", "crit", message(err), { error: message(err) }));
    }
    try {
      const tunnels = await api.tunnels(accountId);
      const id = tunnelId ?? values.tunnelId;
      const tunnel: Tunnel | undefined = id ? tunnels.find((t) => t.id === id) : undefined;
      if (id && !tunnel) {
        results.push(check("tunnel", "Tunnel", "crit", `No tunnel ${id} on this account`));
      } else if (tunnel) {
        const status = tunnel.status === "healthy" ? "ok" : tunnel.status === "inactive" ? "warn" : "crit";
        const detail =
          tunnel.status === "inactive"
            ? `Tunnel "${tunnel.name}" has no cloudflared connected yet`
            : `Tunnel "${tunnel.name}" is ${tunnel.status}`;
        results.push(check("tunnel", "Tunnel", status, detail));
      } else {
        results.push(check("tunnel", "Tunnel", "ok", "Tunnel scope granted; no tunnel chosen yet"));
      }
    } catch (err) {
      results.push(check("tunnel", "Tunnel", "crit", message(err), { error: message(err) }));
    }
    if (accessApps.get() !== "never") {
      try {
        await api.accessApps(accountId);
        results.push(check("access", "Access apps", "ok", "Access apps can be managed"));
      } catch (err) {
        results.push(check("access", "Access apps", "crit", message(err), { error: message(err) }));
      }
      if (parseAllow(values.accessEmails).length === 0) {
        results.push(
          check(
            "access-allow",
            "Access allow list",
            "warn",
            "Empty, so no Access app is created: Edit the connector and name who may sign in (emails or @domains)"
          )
        );
      }
    }
    return results;
  }

  // The connector's Public address when set; otherwise, when a host is
  // direct, the one looked up now. A change is logged, and the records
  // follow it in the same sync.
  async function publicAddress(
    instance: ConnectorInstance,
    needed: boolean,
    signal?: AbortSignal
  ): Promise<{ address?: string; source?: "set" | "detected"; missing?: string }> {
    const set = instance.config.publicAddress?.trim();
    if (set) return { address: set, source: "set" };
    if (!needed) return {};
    try {
      const address = await detect(signal);
      const last = store.view();
      if (last?.publicAddressSource === "detected" && last.publicAddress && last.publicAddress !== address) {
        ctx.log.info(`public address changed from ${last.publicAddress} to ${address}; updating direct records`);
      }
      return { address, source: "detected" };
    } catch (err) {
      return { missing: message(err) };
    }
  }

  async function reconcile(
    instance: ConnectorInstance,
    owned: Parameters<NonNullable<ConnectorKind["reconcile"]>>[1],
    signal: AbortSignal
  ): Promise<DriftReport> {
    const checkedAt = now();
    const base: CloudflareView = {
      connectorId: instance.id,
      accountId: instance.config.accountId,
      zone: instance.config.zone,
      accessPolicy: accessApps.get(),
      hosts: [],
      syncedAt: checkedAt,
      ...(instance.config.publicAddress ? { publicAddress: instance.config.publicAddress } : {}),
    };
    try {
      const api = client(instance.secrets.apiToken ?? "", signal);
      const zone = (await api.zones(instance.config.accountId, instance.config.zone))[0];
      if (!zone) throw new Error(`${instance.config.zone} isn't on this account, or the token can't see it`);
      const access = await ctx.services.get("deploy").access();
      const tunnelId = tunnelIdOf(instance);
      let tunnel: CloudflareTunnelView | undefined;
      let existingTunnels: CloudflareView["existingTunnels"];
      if (tunnelId) {
        const t = await api.tunnel(instance.config.accountId!, tunnelId);
        const kept = store.tunnel();
        tunnel = { id: t.id, name: t.name, status: t.status, adopted: !(kept?.id === t.id && kept.created) };
      } else {
        existingTunnels = (await api.tunnels(instance.config.accountId!).catch(() => []))
          .map((t) => ({ id: t.id, name: t.name, status: t.status }))
          .toSorted((a, b) => a.name.localeCompare(b.name));
      }
      const warnings = await wildcardWarnings(api, instance.config.accountId!, zone, tunnelId).catch(() => []);
      const view: CloudflareView = {
        ...base,
        ...(tunnel ? { tunnel } : {}),
        ...(existingTunnels?.length ? { existingTunnels } : {}),
        ...(access.ingressService ? { ingressService: access.ingressService } : {}),
        ...(warnings.length ? { warnings } : {}),
      };
      if (access.mode !== "cloudflare-tunnel" && access.mode !== "direct") {
        // Nothing is removed: an unset or other mode is not a request to unpublish.
        store.setView({
          ...view,
          error: access.mode
            ? `The Access step is set to ${access.mode}; Cloudflare publishes apps only for Cloudflare Tunnel or Direct.`
            : "Choose how people reach your apps in the Access step first.",
        });
        return { checkedAt, items: [] };
      }
      const prefs = store.prefs();
      const defaultExposure = access.mode === "direct" ? "direct" : "tunnel";
      const needsAddress = access.hosts.some((h) => (prefs.get(h.host)?.exposure ?? defaultExposure) === "direct");
      const address = await publicAddress(instance, needsAddress, signal);
      const gates = await ctx.services
        .get("deploy")
        .gate()
        .catch(() => undefined);
      const gateOf = (host: string) => gates?.apps.find((a) => a.hosts.includes(host))?.state;
      const result = await sync({
        client: api,
        accountId: instance.config.accountId!,
        zone: { id: zone.id, name: zone.name },
        ...(tunnelId ? { tunnelId } : {}),
        ...(access.ingressService ? { ingressService: access.ingressService } : {}),
        ...(address.address ? { publicAddress: address.address } : {}),
        ...(address.missing ? { publicAddressMissing: address.missing } : {}),
        allow: parseAllow(instance.config.accessEmails),
        accessPolicy: accessApps.get(),
        defaultExposure,
        hosts: access.hosts.map((h) => {
          const gate = gateOf(h.host);
          return {
            host: h.host,
            ...(h.appId ? { appId: h.appId } : {}),
            ...(h.appId && noLogin(h.appId) ? { noLogin: true } : {}),
            ...(gate ? { gate } : {}),
          };
        }),
        prefs,
        owned,
        marker,
      });
      if (result.hosts.some((h) => h.exposure === "direct") || owned.list("k8s-direct-tls").length > 0) {
        const discovery = await ctx.services.get("catalog").discover();
        await directTls({
          k8s: ctx.services.get("k8s"),
          deploy: ctx.services.get("deploy"),
          owned,
          prefix: product.ownerMarker.externalPrefix,
          ...(discovery.suggested.clusterIssuer ? { issuer: discovery.suggested.clusterIssuer } : {}),
          views: result.hosts,
        });
      }
      store.setView({
        ...view,
        ...(address.address ? { publicAddress: address.address, publicAddressSource: address.source } : {}),
        hosts: result.hosts,
      });
      return { checkedAt, items: result.items };
    } catch (err) {
      store.setView({ ...(store.view() ?? base), syncedAt: checkedAt, error: message(err) });
      throw err;
    }
  }

  const kind: ConnectorKind = {
    kind: KIND,
    label: "Cloudflare",
    description:
      "Publishes every app hostname: DNS records, tunnel routes and, if you want them, Cloudflare Access apps. " +
      "Needs an API token with Cloudflare Tunnel Edit and DNS Edit.",
    capabilities: ["dns", "tunnel", "access"],
    fields: FIELDS,
    single: true,
    docsUrl: "https://dash.cloudflare.com/profile/api-tokens",
    verify: (values, signal) => verify(values, signal),
    health: (instance, signal) => verify({ ...instance.config, ...instance.secrets }, signal, tunnelIdOf(instance)),
    reconcile,
    async cleanup(instance, owned) {
      const api = client(instance.secrets.apiToken ?? "");
      let zoneId: string | undefined;
      try {
        zoneId = (await api.zones(instance.config.accountId, instance.config.zone))[0]?.id;
      } catch {
        zoneId = undefined;
      }
      const result = await cleanup(api, instance.config.accountId ?? "", zoneId, tunnelIdOf(instance), owned);
      const tls = await removeAllTls(ctx.services.get("deploy"), owned);
      store.clear();
      return { removed: result.removed + tls.removed, errors: [...result.errors, ...tls.errors] };
    },
  };
  ctx.services.get("connectors").addKind(kind);

  const registry = () => ctx.services.get("connectors");
  const instance = async () => (await registry().instances(KIND))[0];
  const required = async () => {
    const found = await instance();
    if (!found) throw new HttpError(409, "Add the Cloudflare connector first (Admin > Connectors).");
    return found;
  };
  // The tunnel's state as Cloudflare reports it now (healthy means a
  // cloudflared is connected), not as of the last sync.
  const freshTunnel = async (found: ConnectorInstance, kept: CloudflareTunnelView) => {
    try {
      const t = await client(found.secrets.apiToken ?? "").tunnel(found.config.accountId ?? "", kept.id);
      return { ...kept, name: t.name, status: t.status };
    } catch {
      return kept;
    }
  };
  const currentView = async (): Promise<CloudflareView> => {
    const found = await instance();
    if (!found) return { accessPolicy: accessApps.get(), hosts: [] };
    const saved = store.view();
    return saved?.connectorId === found.id
      ? {
          ...saved,
          accessPolicy: accessApps.get(),
          ...(saved.tunnel ? { tunnel: await freshTunnel(found, saved.tunnel) } : {}),
        }
      : {
          connectorId: found.id,
          accountId: found.config.accountId,
          zone: found.config.zone,
          accessPolicy: accessApps.get(),
          hosts: [],
        };
  };
  const syncNow = async (id: string) => {
    await registry()
      .reconcile(id)
      .catch(() => undefined);
  };

  let policySeen = accessApps.get();
  ctx.scheduler.every("connector-cloudflare.access-setting", SETTING_POLL_MS, async () => {
    const policy = accessApps.get();
    if (policy === policySeen) return;
    policySeen = policy;
    const found = await instance();
    if (found) await syncNow(found.id);
  });

  // A detected address is checked more often than the reconcile runs, so
  // direct records follow a dynamic IP within minutes.
  ctx.scheduler.every("connector-cloudflare.public-address", ADDRESS_POLL_MS, async (signal) => {
    const last = store.view();
    if (last?.publicAddressSource !== "detected" || !last.connectorId) return;
    const address = await detect(signal);
    if (address !== last.publicAddress) await syncNow(last.connectorId);
  });

  // New apps get their records shortly after their deploy finishes.
  let timer: NodeJS.Timeout | undefined;
  ctx.bus.on("deploy.finished", (event) => {
    if (event.state !== "succeeded" || event.mode === "dry-run") return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void instance().then((found) => (found ? syncNow(found.id) : undefined));
    }, SYNC_DEBOUNCE_MS);
    timer.unref();
  });

  ctx.route("GET /api/connector-cloudflare/view", () => currentView());

  ctx.route("POST /api/connector-cloudflare/sync", async (req, res) => {
    const user = ctx.require(req, res, "admin");
    if (!user) return undefined;
    const found = await required();
    await syncNow(found.id);
    ctx.audit.record({ actor: user.id, action: "connector-cloudflare.sync", target: found.id });
    await ensureCloudflared(req, user.id, found).catch((err: unknown) =>
      ctx.log.warn("cloudflared not deployed on sync", { error: message(err) })
    );
    return currentView();
  });

  ctx.route("PUT /api/connector-cloudflare/hosts/:host", async (req, res) => {
    const user = ctx.require(req, res, "admin");
    if (!user) return undefined;
    const host = req.params.host.toLowerCase();
    const body = parse(hostRequest, req.body);
    const found = await required();
    const access = await ctx.services.get("deploy").access();
    if (!access.hosts.some((h) => h.host === host))
      throw new HttpError(404, `${host} isn't one of the Access step's hosts.`);
    const prev = store.prefs().get(host) ?? {};
    const next = { ...prev, ...body };
    store.setPrefs(host, next, user.id, now());
    ctx.audit.record({
      actor: user.id,
      action: "connector-cloudflare.host",
      target: host,
      detail: [
        next.exposure && `exposure ${next.exposure}`,
        next.access !== undefined && `access ${next.access ? "on" : "off"}`,
      ]
        .filter(Boolean)
        .join(", "),
    });
    await syncNow(found.id);
    const view = (await currentView()).hosts.find((h) => h.host === host);
    if (!view) throw new HttpError(502, "The sync didn't report this host; see the connector's checks.");
    return view;
  });

  ctx.route("POST /api/connector-cloudflare/discover", async (req, res) => {
    if (!ctx.require(req, res, "admin")) return undefined;
    const { token } = parse(discoverRequest, req.body);
    const api = client(token);
    let tokenStatus: string;
    try {
      tokenStatus = (await api.verifyToken()).status;
    } catch {
      // Account-owned tokens verify only under their account; listing
      // accounts below is the real test.
      tokenStatus = "unverified";
    }
    let accounts: CloudflareDiscovery["accounts"] = [];
    let accountsError: unknown;
    try {
      accounts = (await api.accounts()).map((a) => ({ id: a.id, name: a.name }));
    } catch (err) {
      accountsError = err;
    }
    const rawZones = await api.zones().catch(() => []);
    // Without Account Settings the account list is refused or empty; the
    // zones still name their account.
    for (const zone of rawZones) {
      if (!accounts.some((a) => a.id === zone.account.id)) {
        accounts.push({ id: zone.account.id, name: zone.account.name ?? zone.account.id });
      }
    }
    if (!accounts.length) {
      throw new HttpError(
        400,
        accountsError
          ? `The token can't list accounts: ${message(accountsError)}`
          : 'The token sees no account or zone: give it "Zone > DNS > Edit" on your zone'
      );
    }
    if (tokenStatus === "unverified" && accounts[0]) {
      tokenStatus = (await api.verifyToken(accounts[0].id).catch(() => ({ status: "unverified" }))).status;
    }
    const zones = rawZones.map((zone) => ({ id: zone.id, name: zone.name, accountId: zone.account.id }));
    const tunnels: CloudflareDiscovery["tunnels"] = [];
    for (const account of accounts) {
      const found = await api.tunnels(account.id).catch(() => []);
      tunnels.push(...found.map((t) => ({ id: t.id, name: t.name, status: t.status, accountId: account.id })));
    }
    return { tokenStatus, accounts, zones, tunnels };
  });

  ctx.route("POST /api/connector-cloudflare/tunnel", async (req, res) => {
    const user = ctx.require(req, res, "admin");
    if (!user) return undefined;
    const body = parse(tunnelRequest, req.body);
    const found = await required();
    if (found.config.tunnelId) {
      throw new HttpError(
        409,
        "The connector's Tunnel ID field picks the tunnel; clear it in Admin > Connectors to change it here."
      );
    }
    const api = client(found.secrets.apiToken ?? "");
    const accountId = found.config.accountId ?? "";
    if (body.tunnelId) {
      const tunnel = await api.tunnel(accountId, body.tunnelId).catch((err: unknown) => {
        throw new HttpError(400, `tunnelId: ${message(err)}`);
      });
      store.setTunnel(tunnel.id, false);
      ctx.audit.record({
        actor: user.id,
        action: "connector-cloudflare.tunnel-adopt",
        target: tunnel.id,
        detail: tunnel.name,
      });
    } else if (!store.tunnel()) {
      const name = body.name ?? product.slug;
      const existing = (await api.tunnels(accountId)).find((t) => t.name === name);
      if (existing) {
        throw new HttpError(409, `A tunnel named "${name}" already exists: use it, or create one with another name.`);
      }
      const tunnel = await api.createTunnel(accountId, name).catch((err: unknown) => {
        throw new HttpError(502, message(err));
      });
      store.setTunnel(tunnel.id, true);
      ctx.audit.record({
        actor: user.id,
        action: "connector-cloudflare.tunnel-create",
        target: tunnel.id,
        detail: name,
      });
    }
    await syncNow(found.id);
    return currentView();
  });

  // The token is fetched and passed server-side; it never reaches a browser.
  const deployCloudflared = async (req: Request, actor: string, found: ConnectorInstance, tunnelId: string) => {
    const tunnelToken = await client(found.secrets.apiToken ?? "")
      .tunnelToken(found.config.accountId ?? "", tunnelId)
      .catch((err: unknown) => {
        throw new HttpError(502, message(err));
      });
    const job = await ctx.call(req, "POST /api/deploy/jobs", {
      body: { appId: "cloudflared", mode: "install", inputs: { tunnelToken } },
    });
    ctx.audit.record({ actor, action: "connector-cloudflare.tunnel-deploy", target: tunnelId, detail: job.id });
    return job;
  };

  // A sync also brings up cloudflared when nothing serves the tunnel: the
  // bundle's API-token path doesn't deploy it, and a tunnel without one
  // answers every host with error 1033.
  const ensureCloudflared = async (req: Request, actor: string, found: ConnectorInstance) => {
    const tunnelId = tunnelIdOf(found);
    const view = await currentView();
    if (!tunnelId || !view.tunnel || !["inactive", "down"].includes(view.tunnel.status)) return;
    const access = await ctx.services.get("deploy").access();
    if (access.mode && access.mode !== "cloudflare-tunnel") return;
    if (access.appId === "cloudflared" && access.appInstalled) return;
    const jobs = await ctx.call(req, "GET /api/deploy/jobs", { query: { appId: "cloudflared", limit: "5" } });
    if (jobs.some((j) => j.state === "pending" || j.state === "running")) return;
    await deployCloudflared(req, actor, found, tunnelId);
  };

  ctx.route("POST /api/connector-cloudflare/tunnel/deploy", async (req, res) => {
    const user = ctx.require(req, res, "admin");
    if (!user) return undefined;
    const found = await required();
    const tunnelId = tunnelIdOf(found);
    if (!tunnelId) throw new HttpError(409, "Create or pick a tunnel first.");
    return deployCloudflared(req, user.id, found, tunnelId);
  });
}

const mod: Module = {
  id: "connector-cloudflare",
  milestone: "B",
  migrations,
  register,
};

export default mod;

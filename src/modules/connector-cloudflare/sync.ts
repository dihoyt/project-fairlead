import { createHash } from "node:crypto";
import type {
  CloudflareAccessPolicy,
  CloudflareExposure,
  CloudflareHostView,
  CloudflareObjectState,
  OwnedStore,
} from "../../contracts/connectors.js";
import type { Status } from "../../contracts/health.js";
import type { DriftItem } from "../../contracts/ownership.js";
import type {
  AccessApp,
  AccessAppInput,
  CloudflareClient,
  DnsRecord,
  DnsRecordInput,
  TunnelIngressRule,
} from "./api.js";

export const DNS = "cf-dns-record";
export const ROUTE = "cf-tunnel-route";
export const ACCESS = "cf-access-app";
const CATCH_ALL: TunnelIngressRule = { service: "http_status:404" };
const ADDRESS_TYPES = new Set(["A", "AAAA", "CNAME"]);

export interface Marker {
  // Written into the DNS record comment.
  tag: string;
  // Access app names start with it.
  prefix: string;
  // Recognises the current marker or a legacy one.
  ownsComment(comment: string | null | undefined): boolean;
  ownsName(name: string): boolean;
}

export interface HostPrefs {
  exposure?: CloudflareExposure;
  access?: boolean;
}

export interface SyncInput {
  client: CloudflareClient;
  accountId: string;
  zone: { id: string; name: string };
  tunnelId?: string;
  ingressService?: string;
  publicAddress?: string;
  // Emails and @domains Access lets in.
  allow: string[];
  accessPolicy: CloudflareAccessPolicy;
  defaultExposure: CloudflareExposure;
  hosts: Array<{ host: string; appId?: string; noLogin?: boolean }>;
  prefs: Map<string, HostPrefs>;
  owned: OwnedStore;
  marker: Marker;
}

export interface SyncResult {
  items: DriftItem[];
  hosts: CloudflareHostView[];
}

export function specHash(spec: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(spec).toSorted(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}

export const inZone = (host: string, zone: string) => host === zone || host.endsWith(`.${zone}`);

// Under "per-app" an app with no sign-in of its own starts behind Access.
export function wantsAccess(policy: CloudflareAccessPolicy, prefs: HostPrefs | undefined, noLogin = false): boolean {
  return policy === "always" || (policy === "per-app" && (prefs?.access ?? noLogin));
}

export function parseAllow(list: string | undefined): string[] {
  return (list ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes("@"));
}

function accessRules(allow: string[]) {
  return allow.map((entry) =>
    entry.startsWith("@") ? { email_domain: { domain: entry.slice(1) } } : { email: { email: entry } }
  );
}

const describeDns = (r: Pick<DnsRecord, "type" | "name" | "content" | "proxied">) =>
  `${r.type} ${r.name} -> ${r.content}${r.proxied ? " (proxied)" : " (DNS only)"}`;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// One pass over every host: DNS record, tunnel route, Access app. Touches
// only what `owned` records (or an unrecorded object carrying the marker,
// which it adopts); anything else in the way is "conflict-unowned".
export async function sync(input: SyncInput): Promise<SyncResult> {
  const { client, accountId, zone, owned } = input;
  const items: DriftItem[] = [];
  const views: CloudflareHostView[] = [];
  const managed = input.hosts.filter((h) => inZone(h.host, zone.name));

  const exposureOf = (host: string) => input.prefs.get(host)?.exposure ?? input.defaultExposure;

  // --- tunnel routes, one config for all hosts ---
  const routeStates = new Map<string, CloudflareObjectState>();
  const tunnelHosts = managed.filter((h) => exposureOf(h.host) === "tunnel").map((h) => h.host);
  if (input.tunnelId && input.ingressService) {
    const config = await client.tunnelConfig(accountId, input.tunnelId);
    const rules = config.ingress ?? [];
    const service = input.ingressService;
    const ours: TunnelIngressRule[] = [];
    let changed = false;
    for (const host of tunnelHosts) {
      const rule = rules.find((r) => r.hostname === host && !r.path);
      const recorded = owned.get(host, ROUTE);
      const want = { hostname: host, service };
      const spec = { hostname: host, service, tunnelId: input.tunnelId };
      if (rule && !recorded && rule.service !== service) {
        items.push({
          key: host,
          kind: ROUTE,
          state: "conflict-unowned",
          diff: [{ path: "service", want: service, have: rule.service }],
        });
        routeStates.set(host, {
          state: "conflict-unowned",
          detail: `A route for ${host} to ${rule.service} exists that this install didn't create; left alone`,
        });
        continue;
      }
      let state: DriftItem["state"] = "in-sync";
      let diff: DriftItem["diff"];
      if (!rule && recorded) state = "missing";
      if (rule && recorded && rule.service !== recorded.spec.service) {
        state = "drifted";
        diff = [{ path: "service", want: service, have: rule.service }];
      }
      if (!rule || rule.service !== service) changed = true;
      ours.push(rule ? { ...rule, service } : want);
      owned.put({ key: host, kind: ROUTE, spec, specHash: specHash(spec) });
      items.push({ key: host, kind: ROUTE, state, ...(diff ? { diff } : {}) });
      routeStates.set(host, { state, detail: `${host} -> ${service}` });
    }
    const keep = new Set(ours.map((r) => r.hostname));
    const conflicts = new Set([...routeStates].filter(([, s]) => s.state === "conflict-unowned").map(([h]) => h));
    const stale = new Set(
      owned
        .list(ROUTE)
        .filter((r) => !keep.has(r.key) && !conflicts.has(r.key))
        .map((r) => r.key)
    );
    for (const host of stale) owned.delete(host, ROUTE);
    const others = rules.filter((r) => r.hostname && !keep.has(r.hostname) && !stale.has(r.hostname));
    if (rules.some((r) => r.hostname && stale.has(r.hostname))) changed = true;
    const last = rules.findLast((r) => !r.hostname) ?? CATCH_ALL;
    if (!rules.some((r) => !r.hostname)) changed = true;
    if (changed) {
      await client.putTunnelConfig(accountId, input.tunnelId, { ...config, ingress: [...ours, ...others, last] });
    }
  }

  // --- DNS records and Access apps, per host ---
  const wantAccess = managed.some((h) => wantsAccess(input.accessPolicy, input.prefs.get(h.host), h.noLogin));
  const recordedAccess = owned.list(ACCESS).length > 0;
  const apps: AccessApp[] = wantAccess || recordedAccess ? await client.accessApps(accountId) : [];

  for (const { host, appId, noLogin } of input.hosts) {
    const exposure = exposureOf(host);
    const access = wantsAccess(input.accessPolicy, input.prefs.get(host), noLogin);
    const base = { host, ...(appId ? { appId } : {}), exposure, access, ...(noLogin ? { noLogin } : {}) };
    if (!inZone(host, zone.name)) {
      views.push({
        ...base,
        dns: { state: "pending", detail: `Not in the zone ${zone.name}` },
        status: "unknown",
        detail: `${host} isn't in ${zone.name}, so this connector can't publish it`,
      });
      continue;
    }
    let dns: CloudflareObjectState;
    try {
      dns = await syncDns(input, host, exposure, items);
    } catch (err) {
      dns = { state: "pending", detail: message(err) };
    }
    let accessApp: CloudflareObjectState | undefined;
    try {
      accessApp = await syncAccess(input, host, access, apps, items);
    } catch (err) {
      accessApp = { state: "pending", detail: message(err) };
    }
    const route =
      exposure === "tunnel"
        ? (routeStates.get(host) ?? {
            state: "pending" as const,
            detail: !input.tunnelId
              ? "No tunnel yet: create or pick one"
              : "The ingress service isn't known yet; is the ingress controller installed?",
          })
        : undefined;
    views.push({
      ...base,
      dns,
      ...(route ? { route } : {}),
      ...(accessApp ? { accessApp } : {}),
      ...judge(exposure, dns, route, accessApp, noLogin === true && !access),
    });
  }

  // Hosts that left the Access step: remove their records and apps.
  const current = new Set(managed.map((h) => h.host));
  for (const row of owned.list(DNS)) {
    if (current.has(row.key)) continue;
    if (row.externalId) await client.deleteDns(zone.id, row.externalId).catch(ignoreNotFound);
    owned.delete(row.key, DNS);
  }
  for (const row of owned.list(ACCESS)) {
    if (current.has(row.key)) continue;
    if (row.externalId) await client.deleteAccessApp(accountId, row.externalId).catch(ignoreNotFound);
    owned.delete(row.key, ACCESS);
  }
  return { items, hosts: views };
}

function ignoreNotFound(err: unknown) {
  if ((err as { status?: number }).status === 404) return;
  throw err;
}

function judge(
  exposure: CloudflareExposure,
  dns: CloudflareObjectState,
  route: CloudflareObjectState | undefined,
  accessApp: CloudflareObjectState | undefined,
  open = false
): { status: Status; detail: string } {
  const parts = [dns, route, accessApp].filter((p): p is CloudflareObjectState => p !== undefined);
  const conflict = parts.find((p) => p.state === "conflict-unowned");
  if (conflict) return { status: "crit", detail: conflict.detail };
  const pending = parts.find((p) => p.state === "pending");
  if (pending) return { status: "warn", detail: pending.detail };
  if (open) {
    return {
      status: "warn",
      detail: "It has no sign-in of its own and no Cloudflare Access: anyone with the link can use it",
    };
  }
  if (exposure === "direct") return { status: "ok", detail: `Straight to your public address (${dns.detail})` };
  return {
    status: "ok",
    detail: accessApp ? "Routed over the tunnel behind Cloudflare Access" : "Routed over the tunnel",
  };
}

async function syncDns(
  input: SyncInput,
  host: string,
  exposure: CloudflareExposure,
  items: DriftItem[]
): Promise<CloudflareObjectState> {
  const { client, zone, owned, marker } = input;
  let want: DnsRecordInput;
  if (exposure === "tunnel") {
    if (!input.tunnelId) return { state: "pending", detail: "No tunnel yet: create or pick one" };
    want = {
      type: "CNAME",
      name: host,
      content: `${input.tunnelId}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
      comment: marker.tag,
    };
  } else {
    if (!input.publicAddress) return { state: "pending", detail: "Set the public address for direct apps" };
    const type = input.publicAddress.includes(":") ? "AAAA" : "A";
    want = { type, name: host, content: input.publicAddress, proxied: false, ttl: 1, comment: marker.tag };
  }
  const spec = { type: want.type, content: want.content, proxied: want.proxied };
  const records = (await client.dnsRecords(zone.id, host)).filter((r) => ADDRESS_TYPES.has(r.type) && r.name === host);
  const recorded = owned.get(host, DNS);
  const mine = records.find((r) => r.id === recorded?.externalId) ?? records.find((r) => marker.ownsComment(r.comment));
  const foreign = records.find((r) => r !== mine && !marker.ownsComment(r.comment));
  if (foreign) {
    items.push({
      key: host,
      kind: DNS,
      externalId: foreign.id,
      state: "conflict-unowned",
      diff: [{ path: "content", want: want.content, have: foreign.content }],
    });
    return {
      state: "conflict-unowned",
      externalId: foreign.id,
      detail: `${describeDns(foreign)} exists without this install's marker; delete it in Cloudflare to let this one through`,
    };
  }
  let state: DriftItem["state"] = "in-sync";
  let diff: DriftItem["diff"];
  let record: DnsRecord;
  if (!mine) {
    if (recorded) state = "missing";
    record = await client.createDns(zone.id, want);
  } else {
    const last = recorded?.spec;
    if (last && (mine.type !== last.type || mine.content !== last.content || Boolean(mine.proxied) !== last.proxied)) {
      state = "drifted";
      diff = [
        { path: "type", want: last.type, have: mine.type },
        { path: "content", want: last.content, have: mine.content },
        { path: "proxied", want: last.proxied, have: Boolean(mine.proxied) },
      ].filter((d) => d.want !== d.have);
    }
    const same = mine.type === want.type && mine.content === want.content && Boolean(mine.proxied) === want.proxied;
    record = same ? mine : await client.updateDns(zone.id, mine.id, want);
  }
  owned.put({ key: host, kind: DNS, externalId: record.id, spec, specHash: specHash(spec) });
  items.push({ key: host, kind: DNS, externalId: record.id, state, ...(diff ? { diff } : {}) });
  return { state, externalId: record.id, detail: describeDns(want) };
}

async function syncAccess(
  input: SyncInput,
  host: string,
  access: boolean,
  apps: AccessApp[],
  items: DriftItem[]
): Promise<CloudflareObjectState | undefined> {
  const { client, accountId, owned, marker } = input;
  const recorded = owned.get(host, ACCESS);
  const existing = apps.find((a) => a.id === recorded?.externalId) ?? apps.find((a) => a.domain === host);
  const ours = existing && (existing.id === recorded?.externalId || marker.ownsName(existing.name));
  if (!access) {
    if (recorded) {
      if (existing && ours) await client.deleteAccessApp(accountId, existing.id).catch(ignoreNotFound);
      owned.delete(host, ACCESS);
    }
    return undefined;
  }
  if (input.allow.length === 0) {
    return { state: "pending", detail: "Add who may sign in (the Access allow list) to put Access in front of it" };
  }
  if (existing && !ours) {
    items.push({ key: host, kind: ACCESS, externalId: existing.id, state: "conflict-unowned" });
    return {
      state: "conflict-unowned",
      externalId: existing.id,
      detail: `An Access app "${existing.name}" already covers ${host}; left alone`,
    };
  }
  const want: AccessAppInput = {
    name: `${marker.prefix}${host}`,
    domain: host,
    type: "self_hosted",
    session_duration: "24h",
    policies: [{ name: `${marker.prefix}allow`, decision: "allow", include: accessRules(input.allow), precedence: 1 }],
  };
  const spec = { domain: host, allow: input.allow.toSorted() };
  const haveAllow = (existing?.policies ?? [])
    .flatMap((p) => p.include)
    .map((r) => (r.email ? r.email.email : r.email_domain ? `@${r.email_domain.domain}` : ""))
    .filter(Boolean)
    .toSorted();
  let state: DriftItem["state"] = "in-sync";
  let diff: DriftItem["diff"];
  let app: AccessApp;
  if (!existing) {
    if (recorded) state = "missing";
    app = await client.createAccessApp(accountId, want);
  } else {
    const last = (recorded?.spec.allow as string[] | undefined) ?? [];
    if (recorded && JSON.stringify(last) !== JSON.stringify(haveAllow)) {
      state = "drifted";
      diff = [{ path: "allow", want: last, have: haveAllow }];
    }
    app =
      JSON.stringify(haveAllow) === JSON.stringify(spec.allow) && existing.name === want.name
        ? existing
        : await client.updateAccessApp(accountId, existing.id, want);
  }
  owned.put({ key: host, kind: ACCESS, externalId: app.id, spec, specHash: specHash(spec) });
  items.push({ key: host, kind: ACCESS, externalId: app.id, state, ...(diff ? { diff } : {}) });
  return { state, externalId: app.id, detail: `Access app for ${host}: ${input.allow.join(", ")}` };
}

// Deletes everything owned lists. The tunnel itself stays: cloudflared may
// still be using it.
export async function cleanup(
  client: CloudflareClient,
  accountId: string,
  zoneId: string | undefined,
  tunnelId: string | undefined,
  owned: OwnedStore
): Promise<{ removed: number; errors: string[] }> {
  let removed = 0;
  const errors: string[] = [];
  const routes = owned.list(ROUTE);
  if (routes.length > 0 && tunnelId) {
    try {
      const config = await client.tunnelConfig(accountId, tunnelId);
      const drop = new Set(routes.map((r) => r.key));
      const ingress = (config.ingress ?? []).filter((r) => !r.hostname || !drop.has(r.hostname));
      await client.putTunnelConfig(accountId, tunnelId, { ...config, ingress: ingress.length ? ingress : [CATCH_ALL] });
      removed += routes.length;
      for (const r of routes) owned.delete(r.key, ROUTE);
    } catch (err) {
      errors.push(`Tunnel routes: ${message(err)}`);
    }
  }
  for (const row of owned.list(DNS)) {
    try {
      if (row.externalId && zoneId) await client.deleteDns(zoneId, row.externalId).catch(ignoreNotFound);
      owned.delete(row.key, DNS);
      removed++;
    } catch (err) {
      errors.push(`DNS record ${row.key}: ${message(err)}`);
    }
  }
  for (const row of owned.list(ACCESS)) {
    try {
      if (row.externalId) await client.deleteAccessApp(accountId, row.externalId).catch(ignoreNotFound);
      owned.delete(row.key, ACCESS);
      removed++;
    } catch (err) {
      errors.push(`Access app ${row.key}: ${message(err)}`);
    }
  }
  return { removed, errors };
}

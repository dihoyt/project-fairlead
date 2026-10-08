import { lookup } from "node:dns/promises";
import type { Database } from "better-sqlite3";
import type { DiscoveryReport, IngressHost } from "../../contracts/catalog.js";
import type { AccessHost, AccessMode, AccessRequest, AccessView } from "../../contracts/deploy.js";

export const ACCESS_MODES: readonly AccessMode[] = ["cloudflare-tunnel", "tailscale", "local", "direct"];

// The catalog app each mode runs in the cluster.
export const ACCESS_APP: Partial<Record<AccessMode, string>> = {
  "cloudflare-tunnel": "cloudflared",
  tailscale: "tailscale-operator",
};

const LOOKUP_MS = 2_000;
const ADDRESS_PLACEHOLDER = "<ingress IP>";

export interface SavedAccess {
  mode: AccessMode;
  baseDomain: string;
}

export class AccessStore {
  private readonly db: Database;
  private readonly orgId: string;

  constructor(db: Database, orgId: string) {
    this.db = db;
    this.orgId = orgId;
  }

  get(): SavedAccess | undefined {
    const row = this.db.prepare("SELECT mode, base_domain FROM deploy_access WHERE org_id = ?").get(this.orgId) as
      { mode: string; base_domain: string } | undefined;
    if (!row || !ACCESS_MODES.includes(row.mode as AccessMode)) return undefined;
    return { mode: row.mode as AccessMode, baseDomain: row.base_domain };
  }

  set(access: AccessRequest, by: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO deploy_access (org_id, mode, base_domain, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (org_id) DO UPDATE SET mode = excluded.mode, base_domain = excluded.base_domain,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      )
      .run(this.orgId, access.mode, access.baseDomain, by, at);
  }
}

const under = (host: string, domain: string) => host.endsWith(`.${domain}`);

export type Resolver = (host: string) => Promise<boolean>;

// A name that doesn't answer in time counts as not resolving.
export const resolves: Resolver = (host) =>
  Promise.race([
    lookup(host).then(
      () => true,
      () => false
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), LOOKUP_MS).unref()),
  ]);

function hostsFor(mode: AccessMode, baseDomain: string, ingressHosts: IngressHost[]): IngressHost[] {
  return mode === "tailscale"
    ? ingressHosts.filter((h) => h.ingressClass === "tailscale")
    : ingressHosts.filter((h) => h.ingressClass !== "tailscale" && under(h.host, baseDomain));
}

export async function accessView(
  saved: SavedAccess | undefined,
  discovery: DiscoveryReport | undefined,
  resolve: Resolver = resolves
): Promise<AccessView> {
  if (!saved) return { hosts: [] };
  const { mode, baseDomain } = saved;
  const found = hostsFor(mode, baseDomain, discovery?.ingressHosts ?? []).toSorted((a, b) =>
    a.host.localeCompare(b.host)
  );
  const hosts = await Promise.all(
    found.map(async (h): Promise<AccessHost> => {
      // The pod isn't on the tailnet: a lookup there says nothing.
      const looked = mode === "tailscale" ? undefined : await resolve(h.host);
      // Behind the tunnel the edge serves HTTPS whatever the Ingress has.
      const url = mode === "cloudflare-tunnel" ? `https://${h.host}` : h.url;
      return {
        ...(h.appId ? { appId: h.appId } : {}),
        host: h.host,
        url,
        ...(looked === undefined ? {} : { resolves: looked }),
      };
    })
  );
  const appId = ACCESS_APP[mode];
  const app = appId ? discovery?.apps.find((a) => a.appId === appId) : undefined;
  const { ingressService, ingressAddress } = discovery?.suggested ?? {};
  const view: AccessView = {
    mode,
    baseDomain,
    ...(appId ? { appId, appInstalled: app?.state === "installed" } : {}),
    hosts,
  };
  if (mode === "cloudflare-tunnel") {
    view.wildcard = `*.${baseDomain}`;
    if (ingressService) view.ingressService = ingressService;
  }
  if (mode === "direct") {
    view.wildcard = `*.${baseDomain}`;
    if (ingressAddress) view.ingressAddress = ingressAddress;
  }
  if (mode === "local") {
    if (ingressAddress) view.ingressAddress = ingressAddress;
    const address = ingressAddress ?? ADDRESS_PLACEHOLDER;
    view.hostsFile = hosts.map((h) => `${address} ${h.host}\n`).join("");
  }
  return view;
}

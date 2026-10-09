// The slice of Cloudflare's v4 API the connector uses. Every response is the
// v4 envelope { success, errors, result, result_info }; a failure throws a
// CloudflareError carrying Cloudflare's own messages.

export const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 15_000;
const PER_PAGE = 100;

// The token permission each call needs, as Cloudflare's "Create Custom
// Token" form names it, so a refusal can say what to add.
const PERMISSION: Record<string, string> = {
  "List accounts": "Account > Account Settings > Read",
  "Read account": "Account > Account Settings > Read",
  "List zones": "Zone > DNS > Edit",
  "List DNS records": "Zone > DNS > Edit",
  "Create DNS record": "Zone > DNS > Edit",
  "Update DNS record": "Zone > DNS > Edit",
  "Delete DNS record": "Zone > DNS > Edit",
  "List tunnels": "Account > Cloudflare Tunnel > Edit",
  "Read tunnel": "Account > Cloudflare Tunnel > Edit",
  "Create tunnel": "Account > Cloudflare Tunnel > Edit",
  "Read tunnel token": "Account > Cloudflare Tunnel > Edit",
  "Read tunnel routes": "Account > Cloudflare Tunnel > Edit",
  "Save tunnel routes": "Account > Cloudflare Tunnel > Edit",
  "List Access apps": "Account > Access: Apps and Policies > Edit",
  "Create Access app": "Account > Access: Apps and Policies > Edit",
  "Update Access app": "Account > Access: Apps and Policies > Edit",
  "Delete Access app": "Account > Access: Apps and Policies > Edit",
};
// 9109 "Unauthorized to access requested resource" and 10000
// "Authentication error" are what a valid token missing a permission gets.
const DENIED_CODES = new Set([9109, 10000]);

export class CloudflareError extends Error {
  readonly status: number;
  readonly errors: Array<{ code: number; message: string }>;
  // The permission the token lacks, when the refusal is one.
  readonly missingPermission?: string;
  constructor(status: number, errors: Array<{ code: number; message: string }>, what: string) {
    const said = errors.map((e) => `${e.message} (${e.code})`).join("; ") || `HTTP ${status}`;
    const denied = status === 403 || errors.some((e) => DENIED_CODES.has(e.code));
    const permission = denied ? PERMISSION[what] : undefined;
    super(
      permission
        ? `${what}: the API token is missing the "${permission}" permission (Cloudflare said: ${said})`
        : `${what}: ${said}`
    );
    this.status = status;
    this.errors = errors;
    if (permission) this.missingPermission = permission;
  }
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
  comment?: string | null;
}

export type DnsRecordInput = Pick<DnsRecord, "type" | "name" | "content" | "proxied" | "comment"> & { ttl: number };

export interface Tunnel {
  id: string;
  name: string;
  status: string;
  deleted_at?: string | null;
  account_tag?: string;
}

export interface TunnelIngressRule {
  hostname?: string;
  service: string;
  path?: string;
  originRequest?: Record<string, unknown>;
}

export interface TunnelConfig {
  ingress?: TunnelIngressRule[];
  [field: string]: unknown;
}

export interface AccessRule {
  email?: { email: string };
  email_domain?: { domain: string };
}

export interface AccessPolicyInput {
  name: string;
  decision: "allow";
  include: AccessRule[];
  precedence?: number;
}

export interface AccessApp {
  id: string;
  name: string;
  domain: string;
  type: string;
  policies?: Array<{ id?: string; name: string; decision: string; include: AccessRule[] }>;
}

export interface AccessAppInput {
  name: string;
  domain: string;
  type: "self_hosted";
  session_duration: string;
  policies: AccessPolicyInput[];
}

interface Envelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
  result_info?: { page: number; total_pages?: number; count: number; total_count?: number };
}

export class CloudflareClient {
  private readonly base: string;
  private readonly token: string;
  private readonly signal: AbortSignal | undefined;

  constructor(token: string, base = DEFAULT_API_BASE, signal?: AbortSignal) {
    this.base = base.replace(/\/+$/, "");
    this.token = token;
    this.signal = signal;
  }

  private async request<T>(method: string, path: string, what: string, body?: unknown): Promise<Envelope<T>> {
    const signals = [AbortSignal.timeout(TIMEOUT_MS), ...(this.signal ? [this.signal] : [])];
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    const data = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !data?.success) throw new CloudflareError(res.status, data?.errors ?? [], what);
    return data;
  }

  private async all<T>(path: string, what: string): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= 50; page++) {
      const data = await this.request<T[]>("GET", `${path}${sep}page=${page}&per_page=${PER_PAGE}`, what);
      out.push(...data.result);
      const pages = data.result_info?.total_pages ?? 1;
      if (page >= pages || data.result.length < PER_PAGE) break;
    }
    return out;
  }

  // --- token, accounts, zones ---

  async verifyToken(accountId?: string): Promise<{ id: string; status: string }> {
    try {
      return (await this.request<{ id: string; status: string }>("GET", "/user/tokens/verify", "Verify token")).result;
    } catch (err) {
      // Account-owned tokens verify only under their account.
      if (!accountId) throw err;
      const path = `/accounts/${encodeURIComponent(accountId)}/tokens/verify`;
      return (await this.request<{ id: string; status: string }>("GET", path, "Verify token")).result;
    }
  }

  async accounts(): Promise<Array<{ id: string; name: string }>> {
    return this.all("/accounts", "List accounts");
  }

  async account(accountId: string): Promise<{ id: string; name: string }> {
    return (await this.request<{ id: string; name: string }>("GET", `/accounts/${enc(accountId)}`, "Read account"))
      .result;
  }

  async zones(
    accountId?: string,
    name?: string
  ): Promise<Array<{ id: string; name: string; account: { id: string; name?: string } }>> {
    const query = new URLSearchParams();
    if (accountId) query.set("account.id", accountId);
    if (name) query.set("name", name);
    const qs = query.toString();
    return this.all(`/zones${qs ? `?${qs}` : ""}`, "List zones");
  }

  // --- DNS ---

  async dnsRecords(zoneId: string, name?: string): Promise<DnsRecord[]> {
    return this.all(`/zones/${enc(zoneId)}/dns_records${name ? `?name=${enc(name)}` : ""}`, "List DNS records");
  }

  async createDns(zoneId: string, input: DnsRecordInput): Promise<DnsRecord> {
    return (await this.request<DnsRecord>("POST", `/zones/${enc(zoneId)}/dns_records`, "Create DNS record", input))
      .result;
  }

  async updateDns(zoneId: string, id: string, input: DnsRecordInput): Promise<DnsRecord> {
    const path = `/zones/${enc(zoneId)}/dns_records/${enc(id)}`;
    return (await this.request<DnsRecord>("PUT", path, "Update DNS record", input)).result;
  }

  async deleteDns(zoneId: string, id: string): Promise<void> {
    await this.request("DELETE", `/zones/${enc(zoneId)}/dns_records/${enc(id)}`, "Delete DNS record");
  }

  // --- tunnels ---

  async tunnels(accountId: string): Promise<Tunnel[]> {
    return this.all(`/accounts/${enc(accountId)}/cfd_tunnel?is_deleted=false`, "List tunnels");
  }

  async tunnel(accountId: string, tunnelId: string): Promise<Tunnel> {
    const path = `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}`;
    return (await this.request<Tunnel>("GET", path, "Read tunnel")).result;
  }

  async createTunnel(accountId: string, name: string): Promise<Tunnel> {
    const path = `/accounts/${enc(accountId)}/cfd_tunnel`;
    return (await this.request<Tunnel>("POST", path, "Create tunnel", { name, config_src: "cloudflare" })).result;
  }

  async tunnelToken(accountId: string, tunnelId: string): Promise<string> {
    const path = `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}/token`;
    return (await this.request<string>("GET", path, "Read tunnel token")).result;
  }

  async tunnelConfig(accountId: string, tunnelId: string): Promise<TunnelConfig> {
    const path = `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}/configurations`;
    const result = (await this.request<{ config?: TunnelConfig | null }>("GET", path, "Read tunnel routes")).result;
    return result?.config ?? {};
  }

  async putTunnelConfig(accountId: string, tunnelId: string, config: TunnelConfig): Promise<void> {
    const path = `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}/configurations`;
    await this.request("PUT", path, "Save tunnel routes", { config });
  }

  // --- Access ---

  async accessApps(accountId: string): Promise<AccessApp[]> {
    return this.all(`/accounts/${enc(accountId)}/access/apps`, "List Access apps");
  }

  async createAccessApp(accountId: string, input: AccessAppInput): Promise<AccessApp> {
    const path = `/accounts/${enc(accountId)}/access/apps`;
    return (await this.request<AccessApp>("POST", path, "Create Access app", input)).result;
  }

  async updateAccessApp(accountId: string, id: string, input: AccessAppInput): Promise<AccessApp> {
    const path = `/accounts/${enc(accountId)}/access/apps/${enc(id)}`;
    return (await this.request<AccessApp>("PUT", path, "Update Access app", input)).result;
  }

  async deleteAccessApp(accountId: string, id: string): Promise<void> {
    await this.request("DELETE", `/accounts/${enc(accountId)}/access/apps/${enc(id)}`, "Delete Access app");
  }
}

const enc = encodeURIComponent;

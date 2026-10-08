import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Database } from "better-sqlite3";
import {
  JOIN_LINK_TTL_MS,
  JOIN_SECRET,
  type JoinLink,
  type JoinLinkSummary,
  type JoinRole,
  type JoinStatus,
} from "../../contracts/cluster.js";
import { RESOURCES, type K8sApi, type KubeObject } from "../../contracts/k8s.js";
import { product } from "../../product.js";
import { HttpError } from "../../runtime/http.js";
import { joinScript, validServerUrl, validToken, validVersion } from "./joinScript.js";

const SA_NAMESPACE = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";
const ETCD_ROLE = "node-role.kubernetes.io/etcd";

export function podNamespace(): string {
  if (process.env.POD_NAMESPACE) return process.env.POD_NAMESPACE;
  try {
    return readFileSync(SA_NAMESPACE, "utf8").trim() || product.defaultNamespace;
  } catch {
    return product.defaultNamespace;
  }
}

interface JoinValues {
  serverUrl: string;
  token: string;
  agentToken?: string;
}

type Lookup =
  { state: "on"; values: JoinValues; version: string } | { state: Exclude<JoinStatus["state"], "on">; reason: string };

interface LinkRow {
  id: string;
  role: JoinRole;
  created_by: string;
  created_at: number;
  expires_at: number;
}

export interface JoinDeps {
  db: Database;
  orgId: string;
  k8s: () => K8sApi;
  namespace: () => string;
  now?: () => number;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function decode(secret: KubeObject, key: string): string | undefined {
  const data = (secret as { data?: Record<string, string> }).data ?? {};
  const value = data[key];
  return value === undefined ? undefined : Buffer.from(value, "base64").toString("utf8").trim();
}

const isForbidden = (err: unknown) => (err as { statusCode?: unknown }).statusCode === 403;

export function createJoin(deps: JoinDeps) {
  const now = deps.now ?? Date.now;

  async function lookup(): Promise<Lookup> {
    const k8s = deps.k8s();
    const version = (await k8s.version()).gitVersion;
    if (!validVersion(version)) {
      return {
        state: "unsupported",
        reason: `This cluster runs ${version}, not k3s; add nodes the way your distribution does.`,
      };
    }
    let secret: KubeObject | null | "absent";
    try {
      secret = await k8s.get(RESOURCES.secrets, JOIN_SECRET.name, deps.namespace());
    } catch (err) {
      if (!isForbidden(err)) throw err;
      return { state: "denied", reason: `Can't read Secret ${JOIN_SECRET.name}: the chart's grant for it is missing.` };
    }
    if (!secret || secret === "absent") {
      return {
        state: "off",
        reason: `No Secret ${JOIN_SECRET.name} in namespace ${deps.namespace()}: the installer writes it when it sets up k3s.`,
      };
    }
    const serverUrl = validServerUrl(decode(secret, JOIN_SECRET.keys.serverUrl) ?? "");
    const token = decode(secret, JOIN_SECRET.keys.token) ?? "";
    const agentToken = decode(secret, JOIN_SECRET.keys.agentToken);
    if (!serverUrl || !validToken(token) || (agentToken !== undefined && !validToken(agentToken))) {
      return {
        state: "off",
        reason: `Secret ${JOIN_SECRET.name} is missing ${JOIN_SECRET.keys.serverUrl} or ${JOIN_SECRET.keys.token}, or one is malformed.`,
      };
    }
    return { state: "on", values: { serverUrl, token, ...(agentToken ? { agentToken } : {}) }, version };
  }

  async function nodes(): Promise<KubeObject[]> {
    const list = await deps.k8s().list(RESOURCES.nodes);
    return list === "absent" ? [] : list;
  }

  async function roles(): Promise<JoinRole[]> {
    const hasEtcd = (await nodes()).some((node) => node.metadata.labels?.[ETCD_ROLE] === "true");
    return hasEtcd ? ["agent", "server"] : ["agent"];
  }

  function activeLinks(): JoinLinkSummary[] {
    const rows = deps.db
      .prepare(
        `SELECT id, role, created_by, created_at, expires_at FROM cluster_join_links
         WHERE org_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC`
      )
      .all(deps.orgId, now()) as LinkRow[];
    return rows.map(summary);
  }

  return {
    async status(): Promise<JoinStatus> {
      const found = await lookup();
      if (found.state !== "on") return { state: found.state, reason: found.reason, roles: [], links: [] };
      return { state: "on", k3sVersion: found.version, roles: await roles(), links: activeLinks() };
    },

    async create(input: { role: JoinRole; baseUrl: string; actor: string }): Promise<JoinLink> {
      const found = await lookup();
      if (found.state !== "on") throw new HttpError(409, found.reason);
      if (!(await roles()).includes(input.role)) {
        throw new HttpError(400, "A server link needs a cluster running embedded etcd; this one can only take agents.");
      }
      const base = new URL(input.baseUrl);
      base.hash = "";
      base.search = "";
      if (!base.pathname.endsWith("/")) base.pathname += "/";
      const token = randomBytes(24).toString("base64url");
      const id = `jl_${randomBytes(6).toString("hex")}`;
      const createdAt = now();
      const expiresAt = createdAt + JOIN_LINK_TTL_MS;
      deps.db
        .prepare(
          `INSERT INTO cluster_join_links (id, org_id, token_hash, role, created_by, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, deps.orgId, hashToken(token), input.role, input.actor, createdAt, expiresAt);
      const url = new URL(`join/${token}`, base).toString();
      return {
        ...summary({ id, role: input.role, created_by: input.actor, created_at: createdAt, expires_at: expiresAt }),
        url,
        command: `curl -fsSL '${url}' | sudo bash`,
      };
    },

    // True when an unused link was revoked.
    revoke(id: string): boolean {
      const result = deps.db
        .prepare(
          `UPDATE cluster_join_links SET revoked_at = ?
           WHERE id = ? AND org_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`
        )
        .run(now(), id, deps.orgId, now());
      return result.changes > 0;
    },

    // Uses the link up before anything else, so two fetches racing for one
    // link can't both get a script. null for any link that can't be used.
    async script(token: string): Promise<{ id: string; role: JoinRole; script: string } | null> {
      const row = deps.db
        .prepare(
          `UPDATE cluster_join_links SET used_at = ?
           WHERE token_hash = ? AND org_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
           RETURNING id, role`
        )
        .get(now(), hashToken(token), deps.orgId, now()) as { id: string; role: JoinRole } | undefined;
      if (!row) return null;
      const found = await lookup();
      if (found.state !== "on") throw new HttpError(503, "Joining isn't available on this cluster right now.");
      const joinToken = row.role === "agent" ? (found.values.agentToken ?? found.values.token) : found.values.token;
      const script = joinScript({
        role: row.role,
        serverUrl: found.values.serverUrl,
        token: joinToken,
        k3sVersion: found.version,
        nodeNames: (await nodes()).map((node) => node.metadata.name),
      });
      return { id: row.id, role: row.role, script };
    },
  };
}

function summary(row: LinkRow): JoinLinkSummary {
  return {
    id: row.id,
    role: row.role,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

// A fixed window over every public join request together: tokens are 192
// random bits, so this guards the k8s API behind each lookup, not the tokens.
export function createRateLimit(limit: number, windowMs: number, now: () => number = Date.now) {
  let windowStart = 0;
  let count = 0;
  return () => {
    const t = now();
    if (t - windowStart >= windowMs) {
      windowStart = t;
      count = 0;
    }
    count += 1;
    return count <= limit;
  };
}

import type { DatabaseStats, Pod } from "./read.js";

// Each instance's exporter, from the operator's default monitoring queries.
// Read from the primary over the pod network: no credentials needed.
export const METRICS_PORT = 9187;
const TIMEOUT_MS = 3_000;

const SAMPLE = /^(cnpg_pg_database_size_bytes|cnpg_backends_total)\{([^}]*)\}\s+([0-9.eE+-]+)/;
const DATNAME = /(?:^|,)datname="([^"]*)"/;

export function parseStats(text: string): DatabaseStats {
  const stats: DatabaseStats = { sizeBytes: new Map(), connections: new Map() };
  for (const line of text.split("\n")) {
    const m = SAMPLE.exec(line);
    if (!m) continue;
    const db = DATNAME.exec(m[2]!)?.[1];
    const value = Number(m[3]);
    if (!db || !Number.isFinite(value)) continue;
    if (m[1] === "cnpg_pg_database_size_bytes") stats.sizeBytes.set(db, value);
    else stats.connections.set(db, (stats.connections.get(db) ?? 0) + value);
  }
  return stats;
}

// Undefined when the primary has no address yet or doesn't answer.
export async function readStats(primary: Pod | undefined, fetcher: typeof fetch): Promise<DatabaseStats | undefined> {
  const ip = primary?.status?.podIP;
  if (!ip) return undefined;
  const host = ip.includes(":") ? `[${ip}]` : ip;
  try {
    const res = await fetcher(`http://${host}:${METRICS_PORT}/metrics`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return undefined;
    return parseStats(await res.text());
  } catch {
    return undefined;
  }
}

import type { BackupTarget } from "../../contracts/backups.js";
import type { CheckResult, HealthProvider, Status } from "../../contracts/health.js";
import { STATUS_SEVERITY } from "../../contracts/health.js";
import type { HostTestResult } from "../../contracts/hosts.js";
import type { ModuleContext } from "../../contracts/module.js";
import { errorMessage } from "../../runtime/log.js";
import { analyze, gather, unreachableChecks, type HostIdentity, type RateState, type Thresholds } from "./collect.js";
import { filesystemFor } from "./parse.js";
import { connect, HostKeyMismatch, type SshTarget } from "./ssh.js";
import { createStore, rowFilesystems, rowPaths, rowResults, type HostRow, type HostStore } from "./store.js";

export const TICK_MS = 15_000;
const CONNECT_TIMEOUT_MS = 10_000;
// Whole-host deadline: connection plus every command, well inside the job's own timeout.
const HOST_DEADLINE_MS = 90_000;
const HOST_CONCURRENCY = 8;

export interface HostsOptions {
  now?: () => number;
  intervalMs: () => number;
  thresholds: () => Thresholds;
}

export interface ProbeTarget extends SshTarget {
  label: string;
}

export function worstStatus(results: CheckResult[]): Status {
  for (const status of STATUS_SEVERITY) if (results.some((r) => r.status === status)) return status;
  return "unknown";
}

function identity(row: Pick<HostRow, "id" | "label" | "username">): HostIdentity {
  return { id: row.id, label: row.label, username: row.username };
}

// "nfs://nas:/volume1/backups/longhorn" → { host: "nas", path: "/volume1/backups/longhorn" }.
export function splitTargetUrl(url: string): { scheme: string; host: string; path: string } | undefined {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/]+)(?::(\d+))?:?(\/[^?#]*)?/i.exec(url.trim());
  if (!m) return undefined;
  return { scheme: m[1]!.toLowerCase(), host: m[2]!.replace(/^\[|\]$/g, "").toLowerCase(), path: m[4] ?? "/" };
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

// A backup target lives on this host's path when its URL names the host and
// a location at or under the path. SMB names a share, not a path; on a NAS a
// share is the last segment of its folder (/volume1/backups is "backups").
export function targetOnPath(row: HostRow, path: string, target: BackupTarget): boolean {
  if (!target.url) return false;
  const url = splitTargetUrl(target.url);
  if (!url) return false;
  let hostname: string | undefined;
  try {
    hostname = (JSON.parse(row.facts) as { hostname?: string }).hostname?.toLowerCase();
  } catch {
    hostname = undefined;
  }
  if (url.host !== row.address.toLowerCase() && url.host !== hostname) return false;
  const base = trimSlash(path);
  if (url.scheme === "cifs" || url.scheme === "smb") {
    const share = url.path.split("/").filter(Boolean)[0];
    return !!share && share === base.split("/").filter(Boolean).at(-1);
  }
  const at = trimSlash(url.path);
  return at === base || at.startsWith(base === "/" ? "/" : `${base}/`);
}

export function startHosts(ctx: ModuleContext, options: HostsOptions) {
  const now = options.now ?? Date.now;
  const store: HostStore = createStore(ctx.db, ctx.orgId);
  const rates = new Map<string, RateState>();
  const lastAttempt = new Map<string, number>();
  const capacities = new Set<string>();

  async function observe(target: SshTarget, host: HostIdentity, prev: RateState | undefined, signal?: AbortSignal) {
    const session = await connect(target, { timeoutMs: CONNECT_TIMEOUT_MS, ...(signal ? { signal } : {}) });
    try {
      const outputs = await gather(session, signal);
      return {
        fingerprint: session.fingerprint,
        observation: analyze(host, outputs, prev, now(), options.thresholds()),
      };
    } finally {
      session.close();
    }
  }

  async function collectRow(row: HostRow, parent?: AbortSignal): Promise<void> {
    lastAttempt.set(row.id, now());
    const at = () => new Date(now()).toISOString();
    const host = identity(row);
    let credential: string | null;
    let problem: string | undefined;
    try {
      credential = await ctx.secrets.get("hosts", row.id);
      if (!credential) problem = "No credential stored for this host; edit it to add a key or password.";
    } catch (err) {
      credential = null;
      problem = `The stored credential could not be read: ${errorMessage(err)}`;
    }
    if (!credential) {
      const results: CheckResult[] = [
        {
          id: `${row.id}.reachable`,
          label: `${row.label}: SSH`,
          status: "unknown",
          detail: problem!,
          observedAt: at(),
        },
      ];
      store.record(row, { status: "unknown", results, at: at(), error: problem! });
      return;
    }
    const signal = parent
      ? AbortSignal.any([parent, AbortSignal.timeout(HOST_DEADLINE_MS)])
      : AbortSignal.timeout(HOST_DEADLINE_MS);
    const target: SshTarget = {
      address: row.address,
      port: row.port,
      username: row.username,
      auth: row.auth,
      credential,
      ...(row.host_key_fingerprint ? { pin: row.host_key_fingerprint } : {}),
    };
    try {
      const { fingerprint, observation } = await observe(target, host, rates.get(row.id), signal);
      rates.set(row.id, observation.rates);
      if (observation.samples.length > 0) ctx.metrics.write(observation.samples);
      if (!row.host_key_fingerprint) store.pinIfUnset(row, fingerprint);
      store.record(row, {
        status: worstStatus(observation.checks),
        results: observation.checks,
        at: at(),
        seen: {
          detectedKind: observation.detectedKind,
          facts: observation.facts,
          filesystems: observation.filesystems,
          fingerprint,
        },
      });
    } catch (err) {
      const message =
        err instanceof HostKeyMismatch
          ? `${err.message} If the host was reinstalled, test it and save the new fingerprint.`
          : `Could not collect from ${row.address}:${row.port}: ${errorMessage(err)}`;
      const results = unreachableChecks(host, message, rowResults(row), now());
      store.record(row, { status: worstStatus(results), results, at: at(), error: message });
      ctx.log.warn("Host collection failed", { host: row.id, error: message });
    }
  }

  async function collectDue(signal: AbortSignal): Promise<void> {
    const interval = options.intervalMs();
    const due = store.list().filter((row) => {
      const last = lastAttempt.get(row.id) ?? (row.last_collected_at ? Date.parse(row.last_collected_at) : 0);
      return now() - last >= interval - TICK_MS / 2;
    });
    let next = 0;
    const worker = async () => {
      while (next < due.length && !signal.aborted) await collectRow(due[next++]!, signal);
    };
    await Promise.all(Array.from({ length: Math.min(HOST_CONCURRENCY, due.length) }, worker));
  }

  const inFlight = new Set<Promise<void>>();

  async function collectHost(id: string): Promise<boolean> {
    const row = store.get(id);
    if (!row) return false;
    const run = collectRow(row);
    inFlight.add(run);
    try {
      await run;
    } finally {
      inFlight.delete(run);
    }
    return true;
  }

  // Resolves once every collection started through collectHost has finished.
  async function settle(): Promise<void> {
    while (inFlight.size > 0) await Promise.allSettled(inFlight);
  }

  // Connects with unsaved settings: nothing is stored or written to metrics.
  async function probe(target: ProbeTarget): Promise<HostTestResult> {
    const host: HostIdentity = { id: "test", label: target.label, username: target.username };
    try {
      const { fingerprint, observation } = await observe(
        target,
        host,
        undefined,
        AbortSignal.timeout(HOST_DEADLINE_MS)
      );
      return {
        ok: true,
        hostKeyFingerprint: fingerprint,
        detectedKind: observation.detectedKind,
        results: observation.checks,
      };
    } catch (err) {
      const error =
        err instanceof HostKeyMismatch
          ? `${err.message} Clear the fingerprint to accept the new key.`
          : errorMessage(err);
      return {
        ok: false,
        ...(err instanceof HostKeyMismatch ? { hostKeyFingerprint: err.actual } : {}),
        results: unreachableChecks(host, error, [], now()),
        error,
      };
    }
  }

  function staleAfter(): number {
    return 3 * options.intervalMs() + 60_000;
  }

  const provider: HealthProvider = {
    id: "hosts",
    category: "hosts",
    label: "Hosts",
    intervalMs: 30_000,
    async collect() {
      const rows = store.list();
      if (rows.length === 0) {
        return [
          {
            id: "none",
            label: "Hosts",
            status: "absent",
            detail: "No hosts added",
            observedAt: new Date(now()).toISOString(),
          },
        ];
      }
      return rows.flatMap((row): CheckResult[] => {
        const results = rowResults(row);
        const observedAt = new Date(now()).toISOString();
        if (results.length === 0) {
          return [
            {
              id: `${row.id}.reachable`,
              label: `${row.label}: SSH`,
              status: "unknown",
              detail: "Waiting for the first collection",
              observedAt,
            },
          ];
        }
        const last = row.last_collected_at ? Date.parse(row.last_collected_at) : 0;
        if (now() - last <= staleAfter()) return results;
        return results.map((r) =>
          r.status === "absent"
            ? r
            : { ...r, status: "unknown", detail: `No collection since ${row.last_collected_at}: ${r.detail}` }
        );
      });
    },
  };

  // CapacitySource has no way to be removed, so one is added per (host, path)
  // as it first appears and answers "no match" once that pair is gone.
  function syncCapacities(): void {
    for (const row of store.list()) {
      for (const path of rowPaths(row)) {
        const key = `${row.id}\u0000${path}`;
        if (capacities.has(key)) continue;
        capacities.add(key);
        const id = row.id;
        const current = () => {
          const fresh = store.get(id);
          return fresh && rowPaths(fresh).includes(path) ? fresh : undefined;
        };
        ctx.backups.addCapacity({
          id: `hosts:${id}:${path}`,
          targetMatch(target) {
            const fresh = current();
            return !!fresh && targetOnPath(fresh, path, target);
          },
          async freeBytes() {
            const fresh = current();
            if (!fresh) throw new Error(`${path} is no longer a backup target path of this host.`);
            const fs = filesystemFor(path, rowFilesystems(fresh));
            if (!fs) throw new Error(`No filesystem data for ${path} on ${fresh.label} yet.`);
            return { free: fs.freeBytes, total: fs.totalBytes };
          },
        });
      }
    }
  }

  function forget(id: string): void {
    rates.delete(id);
    lastAttempt.delete(id);
  }

  return { store, provider, collectDue, collectHost, settle, probe, syncCapacities, forget };
}

export type HostsService = ReturnType<typeof startHosts>;

import { randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";
import type {
  ConnectorInstance,
  ConnectorKind,
  ConnectorKindView,
  ConnectorRegistry,
  ConnectorRemoveResult,
  ConnectorRequest,
  ConnectorTestResult,
  ConnectorUpdate,
  ConnectorValues,
  ConnectorView,
} from "../../contracts/connectors.js";
import { STATUS_SEVERITY, type CheckResult, type Status } from "../../contracts/health.js";
import type { DriftReport } from "../../contracts/ownership.js";
import type { SecretStore } from "../../contracts/platform.js";
import type { Logger } from "../../contracts/runtime.js";
import { HttpError } from "../../runtime/http.js";
import { InstanceStore, ownedStore, toView, type InstanceRow } from "./store.js";

const SCOPE = "connectors";
const VERIFY_TIMEOUT_MS = 20_000;
const MAX_VALUE = 4096;
// The check a failed or conflicting reconcile leaves on the instance; health
// runs keep it until the next reconcile replaces it.
export const RECONCILE_CHECK = "reconcile";

const secretId = (instanceId: string, field: string) => `${instanceId}:${field}`;

export function worst(statuses: Status[]): Status {
  return STATUS_SEVERITY.find((s) => statuses.includes(s)) ?? "unknown";
}

export function kindView(kind: ConnectorKind): ConnectorKindView {
  return {
    kind: kind.kind,
    label: kind.label,
    description: kind.description,
    capabilities: [...kind.capabilities],
    fields: kind.fields.map((f) => ({ ...f })),
    single: kind.single ?? false,
    ...(kind.docsUrl ? { docsUrl: kind.docsUrl } : {}),
  };
}

function failed(id: string, label: string, err: unknown, now: Date): CheckResult {
  const message = err instanceof Error ? err.message : String(err);
  return { id, label, status: "crit", detail: message, raw: { error: message }, observedAt: now.toISOString() };
}

function reconcileCheck(report: DriftReport, now: Date): CheckResult {
  const conflicts = report.items.filter((i) => i.state === "conflict-unowned");
  const fixed = report.items.filter((i) => i.state === "drifted" || i.state === "missing");
  const base = {
    id: RECONCILE_CHECK,
    label: "Objects in sync",
    observedAt: now.toISOString(),
    value: report.items.length,
  };
  if (conflicts.length > 0) {
    return {
      ...base,
      status: "warn",
      detail: `${conflicts.length} object${conflicts.length === 1 ? "" : "s"} in the way that this install didn't create: ${conflicts
        .map((c) => c.key)
        .join(", ")}`,
      raw: conflicts,
    };
  }
  const detail =
    fixed.length > 0
      ? `${report.items.length} objects; put back ${fixed.length} changed or missing outside this install: ${fixed.map((f) => f.key).join(", ")}`
      : `${report.items.length} object${report.items.length === 1 ? "" : "s"} in sync`;
  return { ...base, status: "ok", detail };
}

const secretFields = (kind: ConnectorKind) => kind.fields.filter((f) => f.type === "secret").map((f) => f.key);

// Splits values into config and secrets, refusing unknown keys and
// over-long values. `required` is checked against `present` (stored + new).
function split(kind: ConnectorKind, values: Record<string, unknown>) {
  const config: Record<string, string> = {};
  const sealed: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const field = kind.fields.find((f) => f.key === key);
    if (!field) throw new HttpError(400, `values.${key}: not a field of ${kind.label}.`);
    if (typeof value !== "string") throw new HttpError(400, `values.${key}: must be a string.`);
    if (value.length > MAX_VALUE) throw new HttpError(400, `values.${key}: too long.`);
    if (field.type === "secret") sealed[key] = value.trim();
    else config[key] = value.trim();
    if (field.type === "url" && value.trim()) {
      try {
        const { protocol } = new URL(value.trim());
        if (protocol !== "https:" && protocol !== "http:") throw new Error("scheme");
      } catch {
        throw new HttpError(400, `values.${key}: must be an http(s) URL.`);
      }
    }
  }
  return { config, sealed };
}

function requireFields(kind: ConnectorKind, present: Record<string, string>) {
  const missing = kind.fields.filter((f) => f.required && !present[f.key]);
  if (missing.length > 0) {
    throw new HttpError(400, missing.map((f) => `values.${f.key}: ${f.label} is required.`).join("; "));
  }
}

export interface ConnectorsOptions {
  db: Database;
  orgId: string;
  secrets: SecretStore;
  log: Logger;
  now?: () => Date;
}

export function createConnectors(options: ConnectorsOptions) {
  const { db, orgId, secrets, log } = options;
  const now = options.now ?? (() => new Date());
  const store = new InstanceStore(db, orgId);
  const kinds = new Map<string, ConnectorKind>();
  const running = new Map<string, Promise<DriftReport | undefined>>();

  const kindOf = (name: string): ConnectorKind => {
    const kind = kinds.get(name);
    if (!kind) throw new HttpError(400, `kind: no connector kind "${name}".`);
    return kind;
  };

  async function unseal(row: InstanceRow): Promise<ConnectorInstance> {
    const kind = kinds.get(row.kind);
    const values: Record<string, string> = {};
    for (const key of kind ? secretFields(kind) : []) {
      const value = await secrets.get(SCOPE, secretId(row.id, key));
      if (value !== null) values[key] = value;
    }
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      config: JSON.parse(row.config) as Record<string, string>,
      secrets: values,
    };
  }

  async function view(row: InstanceRow): Promise<ConnectorView> {
    const kind = kinds.get(row.kind);
    const stored: Record<string, boolean> = {};
    for (const key of kind ? secretFields(kind) : []) stored[key] = await secrets.has(SCOPE, secretId(row.id, key));
    return toView(row, stored);
  }

  const rowOr404 = (id: string): InstanceRow => {
    const row = store.get(id);
    if (!row) throw new HttpError(404, "No such connector.");
    return row;
  };

  async function verify(kind: ConnectorKind, values: ConnectorValues): Promise<CheckResult[]> {
    const signal = AbortSignal.timeout(VERIFY_TIMEOUT_MS);
    try {
      return await kind.verify(values, signal);
    } catch (err) {
      return [failed("verify", "Verify", err, now())];
    }
  }

  function record(id: string, checks: CheckResult[]) {
    const row = store.get(id);
    const previous = row ? (JSON.parse(row.checks) as CheckResult[]) : [];
    const keep = previous.filter((c) => c.id === RECONCILE_CHECK && !checks.some((n) => n.id === RECONCILE_CHECK));
    const all = [...checks, ...keep];
    store.setChecks(id, worst(all.map((c) => c.status)), all, now().toISOString());
  }

  async function check(id: string): Promise<void> {
    const row = rowOr404(id);
    const kind = kinds.get(row.kind);
    if (!kind) {
      record(id, [
        {
          id: "kind",
          label: "Connector",
          status: "unknown",
          detail: `The ${row.kind} connector isn't loaded in this version.`,
          observedAt: now().toISOString(),
        },
      ]);
      return;
    }
    const instance = await unseal(row);
    const signal = AbortSignal.timeout(VERIFY_TIMEOUT_MS);
    let checks: CheckResult[];
    try {
      checks = kind.health
        ? await kind.health(instance, signal)
        : await kind.verify({ ...instance.config, ...instance.secrets }, signal);
    } catch (err) {
      checks = [failed("health", "Health", err, now())];
    }
    record(id, checks);
  }

  async function reconcileNow(id: string): Promise<DriftReport | undefined> {
    const row = store.get(id);
    const kind = row && kinds.get(row.kind);
    if (!row || !kind?.reconcile) return undefined;
    const instance = await unseal(row);
    const owned = ownedStore(db, orgId, id, now);
    try {
      const report = await kind.reconcile(instance, owned, AbortSignal.timeout(5 * 60_000));
      store.setDrift(id, report);
      replaceCheck(id, reconcileCheck(report, now()));
      return report;
    } catch (err) {
      log.warn("connector reconcile failed", {
        id,
        kind: row.kind,
        error: err instanceof Error ? err.message : String(err),
      });
      replaceCheck(id, failed(RECONCILE_CHECK, "Objects in sync", err, now()));
      throw err;
    }
  }

  function replaceCheck(id: string, result: CheckResult) {
    const row = store.get(id);
    if (!row) return;
    const checks = (JSON.parse(row.checks) as CheckResult[]).filter((c) => c.id !== result.id);
    checks.push(result);
    store.setChecks(id, worst(checks.map((c) => c.status)), checks, row.checked_at ?? now().toISOString());
  }

  const registry: ConnectorRegistry = {
    addKind(kind) {
      if (kinds.has(kind.kind)) throw new Error(`Connector kind "${kind.kind}" is already registered.`);
      kinds.set(kind.kind, kind);
    },
    instances: async (kind) => Promise.all(store.list(kind).map(unseal)),
    async instance(id) {
      const row = store.get(id);
      return row && unseal(row);
    },
    async view(id) {
      const row = store.get(id);
      return row && view(row);
    },
    owned: (instanceId) => ownedStore(db, orgId, instanceId, now),
    reconcile(id) {
      const inFlight = running.get(id);
      if (inFlight) return inFlight;
      const run = reconcileNow(id).finally(() => running.delete(id));
      running.set(id, run);
      return run;
    },
  };

  return {
    registry,
    kinds: () => [...kinds.values()],
    kind: (name: string) => kinds.get(name),
    rows: () => store.list(),
    view,
    async list(): Promise<ConnectorView[]> {
      return Promise.all(store.list().map(view));
    },
    async get(id: string): Promise<ConnectorView> {
      return view(rowOr404(id));
    },

    async create(body: ConnectorRequest, by: string): Promise<ConnectorView> {
      const kind = kindOf(body.kind);
      if (kind.single && store.list(kind.kind).length > 0) {
        throw new HttpError(409, `Only one ${kind.label} connector can be added; edit the existing one.`);
      }
      const { config, sealed } = split(kind, body.values);
      requireFields(kind, { ...config, ...sealed });
      const id = `cn_${randomBytes(8).toString("hex")}`;
      const at = now().toISOString();
      store.insert({ id, kind: kind.kind, name: body.name, config, by, at });
      for (const [key, value] of Object.entries(sealed)) {
        if (value) await secrets.put(SCOPE, secretId(id, key), value);
      }
      const checks = await verify(kind, { ...config, ...sealed });
      record(id, checks);
      return view(rowOr404(id));
    },

    async update(id: string, body: ConnectorUpdate): Promise<{ view: ConnectorView; secretsChanged: string[] }> {
      const row = rowOr404(id);
      const kind = kindOf(row.kind);
      const { config, sealed } = split(kind, body.values ?? {});
      const merged = { ...(JSON.parse(row.config) as Record<string, string>), ...config };
      const current = await unseal(row);
      const changed = Object.entries(sealed).filter(([, v]) => v !== "");
      requireFields(kind, { ...merged, ...current.secrets, ...Object.fromEntries(changed) });
      store.update(id, body.name ?? row.name, merged, now().toISOString());
      for (const [key, value] of changed) await secrets.put(SCOPE, secretId(id, key), value);
      await check(id);
      return { view: await view(rowOr404(id)), secretsChanged: changed.map(([k]) => k) };
    },

    async test(kindName: string, values: Record<string, unknown>, id?: string): Promise<ConnectorTestResult> {
      const kind = kindOf(kindName);
      const { config, sealed } = split(kind, values);
      let stored: Record<string, string> = {};
      if (id) {
        const row = rowOr404(id);
        if (row.kind !== kind.kind) throw new HttpError(400, "id: that connector is a different kind.");
        stored = (await unseal(row)).secrets;
      }
      const filled = { ...stored, ...Object.fromEntries(Object.entries(sealed).filter(([, v]) => v !== "")) };
      requireFields(kind, { ...config, ...filled });
      const checks = await verify(kind, { ...config, ...filled });
      return { ok: checks.every((c) => c.status !== "crit" && c.status !== "unknown"), checks };
    },

    check,

    async remove(id: string, cleanup: boolean): Promise<ConnectorRemoveResult> {
      const row = rowOr404(id);
      const kind = kinds.get(row.kind);
      let result = { removed: 0, errors: [] as string[] };
      if (cleanup && kind?.cleanup) {
        await running.get(id)?.catch(() => undefined);
        try {
          result = await kind.cleanup(await unseal(row), ownedStore(db, orgId, id, now));
        } catch (err) {
          result.errors.push(err instanceof Error ? err.message : String(err));
        }
      }
      const fields = kind ? secretFields(kind) : [];
      store.delete(id);
      for (const key of fields) await secrets.delete(SCOPE, secretId(id, key));
      return { ok: true, ...result };
    },
  };
}

export type Connectors = ReturnType<typeof createConnectors>;

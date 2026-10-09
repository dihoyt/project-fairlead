import type { CheckResult } from "../../health.js";
import type {
  ConnectorInstance,
  ConnectorKind,
  ConnectorRegistry,
  ConnectorValues,
  OwnedRecord,
  OwnedStore,
} from "../../connectors.js";
import type { DriftItem, DriftReport, OwnedObject } from "../../ownership.js";
import { MOCK_NOW } from "../time.js";

const now = () => new Date(MOCK_NOW).toISOString();
const rowId = (key: string, kind: string) => `${kind}\u0000${key}`;
const spec = (value: string): Pick<OwnedObject, "spec" | "specHash"> => ({ spec: { value }, specHash: value });

export function createMemoryOwnedStore(): OwnedStore {
  const rows = new Map<string, OwnedRecord>();
  return {
    list: (kind) =>
      [...rows.values()].filter((r) => kind === undefined || r.kind === kind).map((r) => structuredClone(r)),
    get: (key, kind) => {
      const row = rows.get(rowId(key, kind));
      return row && structuredClone(row);
    },
    put: (obj) => void rows.set(rowId(obj.key, obj.kind), { ...structuredClone(obj), updatedAt: now() }),
    delete: (key, kind) => void rows.delete(rowId(key, kind)),
  };
}

export interface MockConnectorRegistry extends ConnectorRegistry {
  kinds(): ConnectorKind[];
  // Stores an instance as the connectors module would after a save.
  addInstance(instance: ConnectorInstance): void;
  reports: Map<string, DriftReport>;
}

// In-memory stand-in for module "connectors", so a connector module tests
// its kind without the framework: provide it as services.connectors.
export function createMockConnectorRegistry(instances: ConnectorInstance[] = []): MockConnectorRegistry {
  const kinds = new Map<string, ConnectorKind>();
  const stored = new Map(instances.map((i) => [i.id, structuredClone(i)]));
  const owned = new Map<string, OwnedStore>();
  const reports = new Map<string, DriftReport>();
  const ownedFor = (instanceId: string) => {
    let store = owned.get(instanceId);
    if (!store) owned.set(instanceId, (store = createMemoryOwnedStore()));
    return store;
  };
  return {
    addKind(kind) {
      if (kinds.has(kind.kind)) throw new Error(`Connector kind "${kind.kind}" is already registered.`);
      kinds.set(kind.kind, kind);
    },
    kinds: () => [...kinds.values()],
    addInstance: (instance) => void stored.set(instance.id, structuredClone(instance)),
    instances: async (kind) => [...stored.values()].filter((i) => i.kind === kind).map((i) => structuredClone(i)),
    instance: async (id) => {
      const found = stored.get(id);
      return found && structuredClone(found);
    },
    owned: ownedFor,
    async clearSecret(instanceId, field) {
      const found = stored.get(instanceId);
      if (found) delete found.secrets[field];
    },
    async reconcile(instanceId) {
      const instance = stored.get(instanceId);
      const kind = instance && kinds.get(instance.kind);
      if (!instance || !kind?.reconcile) return undefined;
      const report = await kind.reconcile(
        structuredClone(instance),
        ownedFor(instanceId),
        new AbortController().signal
      );
      reports.set(instanceId, report);
      return report;
    },
    reports,
  };
}

// --- A fake tool and its connector kind -------------------------------------
//
// The tool keeps records by name; each carries a `marker` when this product
// made it. The kind exercises every framework path: verify with a pass and a
// failure, reconcile creating, updating and reporting drift, refusing an
// unmarked record, and cleanup.

export interface FakeToolRecord {
  id: string;
  name: string;
  value: string;
  marker?: string;
}

export interface FakeTool {
  records: Map<string, FakeToolRecord>;
  // Records the next reconcile should hold, by name -> value.
  desired: Map<string, string>;
  // Set to make every call fail as if the tool were unreachable.
  down?: boolean;
}

export const FAKE_MARKER = "managed-by-test";

export function createFakeTool(): FakeTool {
  return { records: new Map(), desired: new Map() };
}

function check(id: string, status: CheckResult["status"], detail: string, raw?: unknown): CheckResult {
  return { id, label: id, status, detail, observedAt: now(), ...(raw === undefined ? {} : { raw }) };
}

export function createFakeConnectorKind(tool: FakeTool): ConnectorKind {
  let seq = 0;
  return {
    kind: "fake",
    label: "Fake tool",
    description: "A connector that talks to nothing, for tests.",
    capabilities: ["dns"],
    fields: [
      { key: "token", label: "Token", type: "secret", required: true },
      { key: "zone", label: "Zone", type: "text", required: true },
    ],
    async verify(values: ConnectorValues) {
      if (tool.down) return [check("reach", "unknown", "The fake tool is unreachable")];
      return values.token === "good"
        ? [check("token", "ok", "Token accepted")]
        : [check("token", "crit", "Token rejected", { error: "invalid token" })];
    },
    async reconcile(_instance, owned) {
      if (tool.down) throw new Error("The fake tool is unreachable");
      const items: DriftItem[] = [];
      for (const [name, value] of tool.desired) {
        const mine = owned.get(name, "fake-record");
        const have = [...tool.records.values()].find((r) => r.name === name);
        if (have && have.marker !== FAKE_MARKER) {
          items.push({ key: name, kind: "fake-record", state: "conflict-unowned" });
          continue;
        }
        if (!have) {
          const id = `fr_${++seq}`;
          tool.records.set(id, { id, name, value, marker: FAKE_MARKER });
          owned.put({ key: name, kind: "fake-record", externalId: id, ...spec(value) });
          items.push({ key: name, kind: "fake-record", externalId: id, state: mine ? "missing" : "in-sync" });
          continue;
        }
        if (have.value !== value) {
          items.push({
            key: name,
            kind: "fake-record",
            externalId: have.id,
            state: "drifted",
            diff: [{ path: "value", want: value, have: have.value }],
          });
          have.value = value;
        } else {
          items.push({ key: name, kind: "fake-record", externalId: have.id, state: "in-sync" });
        }
        owned.put({ key: name, kind: "fake-record", externalId: have.id, ...spec(value) });
      }
      for (const row of owned.list("fake-record")) {
        if (tool.desired.has(row.key)) continue;
        if (row.externalId) tool.records.delete(row.externalId);
        owned.delete(row.key, row.kind);
      }
      return { checkedAt: now(), items };
    },
    async cleanup(_instance, owned) {
      let removed = 0;
      const errors: string[] = [];
      for (const row of owned.list()) {
        if (tool.down) {
          errors.push(`${row.key}: the fake tool is unreachable`);
          continue;
        }
        if (row.externalId && tool.records.delete(row.externalId)) removed++;
        owned.delete(row.key, row.kind);
      }
      return { removed, errors };
    },
  };
}

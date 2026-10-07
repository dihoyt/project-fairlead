// Milestone B (connector reconcile). Defined now so the ownership helpers in
// A1 and the connector framework share one shape; B1 re-checks these against
// the real Cloudflare and Entra APIs before B2-B6 build on them.

export interface OwnedObject {
  // Stable id of what owns it, e.g. the published app id.
  key: string;
  // "cf-access-app", "cf-dns-record", "cf-tunnel-route", "entra-app".
  kind: string;
  // The tool's own id, once created.
  externalId?: string;
  spec: Record<string, unknown>;
  // Hash of spec, so drift is detected without a deep compare every time.
  specHash: string;
}

export type DriftState =
  | "in-sync"
  | "drifted"
  | "missing"
  // An object of the same name exists without this product's marker; never touched.
  | "conflict-unowned";

export interface DriftItem {
  key: string;
  kind: string;
  externalId?: string;
  state: DriftState;
  diff?: Array<{ path: string; want: unknown; have: unknown }>;
}

export interface DriftReport {
  checkedAt: string;
  items: DriftItem[];
}

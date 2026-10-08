// The last three categories are first used in Milestone B.
export type Category =
  "cluster" | "storage" | "backups" | "gitops" | "hosts" | "checks" | "access" | "identity" | "apps";

export const CATEGORIES: readonly Category[] = [
  "cluster",
  "storage",
  "backups",
  "gitops",
  "hosts",
  "checks",
  "access",
  "identity",
  "apps",
];

// "absent" means the thing being checked is not installed (no Velero CRDs,
// say). It is hidden by default and never rolls up into a worse status.
export type Status = "ok" | "warn" | "crit" | "unknown" | "absent";

// Worst first. A roll-up takes the first status in this order that any
// member has; "absent" ranks below "ok" so a missing optional component
// never makes a tile look worse than a healthy one.
export const STATUS_SEVERITY: readonly Status[] = ["crit", "warn", "unknown", "ok", "absent"];

export interface CheckResult {
  // Stable within its provider; (providerId, id) identifies a check across runs.
  id: string;
  label: string;
  status: Status;
  value?: number | string;
  // Always present, pass or fail: "3/3 nodes Ready" as much as "node-2 NotReady".
  detail: string;
  // The object or output the judgement was made from, shown on failure.
  raw?: unknown;
  // A link into the native UI (Longhorn, Rancher, Grafana) for this check.
  deepLink?: string;
  // The Kubernetes object this check is about, for in-app linking.
  object?: { kind: string; namespace?: string; name: string };
  // ISO 8601.
  observedAt: string;
}

export interface HealthProvider {
  // Unique across the install; by convention "<moduleId>" or "<moduleId>.<part>".
  id: string;
  category: Category;
  label: string;
  intervalMs: number;
  // Must not throw: a provider that cannot reach its source returns a
  // CheckResult with status "unknown" saying why. The health module still
  // catches a throw and records it as "unknown".
  collect(): Promise<CheckResult[]>;
}

export interface HealthRegistry {
  addProvider(provider: HealthProvider): void;
  list(): readonly HealthProvider[];
  // Called once for every provider already added, then for each added later,
  // so a consumer registered before its providers still sees them all.
  // Returns an unsubscribe function.
  subscribe(onProvider: (provider: HealthProvider) => void): () => void;
}

// --- HTTP shapes (module "health", A2) -----------------------------------

export interface HealthTile {
  category: Category;
  status: Status;
  // One line: the worst issue, or "All 14 checks OK".
  summary: string;
  counts: { ok: number; warn: number; crit: number; unknown: number; absent: number };
  worst?: CheckResult & { providerId: string };
}

export interface HealthBoard {
  status: Status;
  tiles: HealthTile[];
  generatedAt: string;
}

export interface ProviderState {
  id: string;
  label: string;
  category: Category;
  status: Status;
  lastRunAt?: string;
  // Set when the last collect() threw or timed out.
  lastError?: string;
  results: CheckResult[];
}

export interface CategoryDetail {
  category: Category;
  status: Status;
  providers: ProviderState[];
  // Native UIs configured in settings for this category, then the custom
  // links added through the API (GET /api/health/links).
  links: Array<{ label: string; url: string }>;
}

export interface CheckHistoryPoint {
  at: string;
  status: Status;
  detail: string;
}

export interface CheckHistory {
  providerId: string;
  checkId: string;
  points: CheckHistoryPoint[];
}

// A link shown on a category page. "settings" links come from the
// health.links setting (the wizard's Links step writes it) and are read-only
// here; "custom" ones are added through the API (and MCP) and can be changed
// or deleted there.
export interface HealthLinkView {
  // "settings:<category>:<index>" for a settings link.
  id: string;
  category: Category;
  label: string;
  // http(s) only.
  url: string;
  source: "settings" | "custom";
  createdBy?: string;
  createdAt?: string;
}

export interface HealthLinkRequest {
  category: Category;
  // 1 to 80 characters.
  label: string;
  url: string;
}

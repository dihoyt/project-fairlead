import type { BackupTarget } from "../../contracts/backups.js";
import type { KubeObject } from "../../contracts/k8s.js";
import type { Status } from "../../contracts/health.js";

// The fields of Velero's v1 objects this module reads. Everything else the
// API server sends is left alone.

export interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: Array<{ key: string; operator: string; values?: string[] }>;
}

export interface BackupSpecFields {
  includedNamespaces?: string[];
  excludedNamespaces?: string[];
  includedResources?: string[];
  excludedResources?: string[];
  includedNamespaceScopedResources?: string[];
  excludedNamespaceScopedResources?: string[];
  labelSelector?: LabelSelector;
  orLabelSelectors?: LabelSelector[];
  snapshotVolumes?: boolean | null;
  defaultVolumesToFsBackup?: boolean | null;
  storageLocation?: string;
  resourcePolicy?: { kind?: string; name?: string };
}

export interface VeleroBackup extends KubeObject {
  spec?: BackupSpecFields;
  status?: {
    phase?: string;
    startTimestamp?: string;
    completionTimestamp?: string;
    failureReason?: string;
    errors?: number;
    warnings?: number;
    validationErrors?: string[];
  };
}

export interface VeleroSchedule extends KubeObject {
  spec?: { schedule?: string; paused?: boolean; template?: BackupSpecFields };
  status?: { phase?: string; lastBackup?: string; validationErrors?: string[] };
}

export interface VeleroRestore extends KubeObject {
  spec?: {
    backupName?: string;
    scheduleName?: string;
    includedNamespaces?: string[];
    excludedNamespaces?: string[];
    includedResources?: string[];
    excludedResources?: string[];
  };
  status?: {
    phase?: string;
    startTimestamp?: string;
    completionTimestamp?: string;
    failureReason?: string;
    errors?: number;
    warnings?: number;
    validationErrors?: string[];
  };
}

export interface VeleroLocation extends KubeObject {
  spec?: {
    provider?: string;
    default?: boolean;
    objectStorage?: { bucket?: string; prefix?: string };
    accessMode?: string;
  };
  status?: { phase?: string; message?: string; lastValidationTime?: string; lastSyncedTime?: string };
}

export const SCHEDULE_LABEL = "velero.io/schedule-name";

// Phases a backup or restore ends in; anything else is still running.
const TERMINAL = new Set(["Completed", "PartiallyFailed", "Failed", "FailedValidation"]);

export const isTerminal = (phase: string | undefined) => phase !== undefined && TERMINAL.has(phase);

export function phaseStatus(phase: string | undefined): Status {
  switch (phase) {
    case "Completed":
      return "ok";
    case "PartiallyFailed":
      return "warn";
    case "Failed":
    case "FailedValidation":
      return "crit";
    default:
      return "unknown";
  }
}

const time = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);

// When a backup or restore started: its own start, else when it was created.
export function startedAt(obj: VeleroBackup | VeleroRestore): number {
  const start = time(obj.status?.startTimestamp);
  return Number.isNaN(start) ? time(obj.metadata.creationTimestamp) : start;
}

export function finishedAt(obj: VeleroBackup | VeleroRestore): number {
  const end = time(obj.status?.completionTimestamp);
  return Number.isNaN(end) ? startedAt(obj) : end;
}

export const newestFirst = <T extends VeleroBackup | VeleroRestore>(items: T[]) =>
  items.toSorted((a, b) => startedAt(b) - startedAt(a));

// Why a backup or restore did not simply complete, in one line.
export function problem(obj: VeleroBackup | VeleroRestore): string | undefined {
  const s = obj.status ?? {};
  if (s.phase === "Completed") return undefined;
  if (s.failureReason) return s.failureReason;
  if (s.validationErrors?.length) return s.validationErrors.join("; ");
  if (s.errors) return `${s.errors} error${s.errors === 1 ? "" : "s"}`;
  return s.phase ? `phase ${s.phase}` : undefined;
}

// The schedule a backup came from: the label Velero sets, else the
// "<schedule>-<timestamp>" name it generates.
export function backupSchedule(backup: { metadata: KubeObject["metadata"] }, schedules: string[]): string | undefined {
  const label = backup.metadata.labels?.[SCHEDULE_LABEL];
  if (label) return label;
  return schedules
    .filter((s) =>
      new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{8}-?\\d{6}$`).test(backup.metadata.name)
    )
    .toSorted((a, b) => b.length - a.length)[0];
}

export function locationUrl(loc: VeleroLocation): string | undefined {
  const bucket = loc.spec?.objectStorage?.bucket;
  if (!bucket) return undefined;
  const provider = loc.spec?.provider ?? "";
  const scheme = /aws|s3/.test(provider)
    ? "s3"
    : /azure/.test(provider)
      ? "azure"
      : /gcp/.test(provider)
        ? "gs"
        : provider;
  const prefix = loc.spec?.objectStorage?.prefix;
  return `${scheme || "bucket"}://${bucket}${prefix ? `/${prefix}` : ""}`;
}

export function locationTarget(name: string, loc: VeleroLocation | undefined): BackupTarget {
  const url = loc ? locationUrl(loc) : undefined;
  return {
    id: `velero:${name}`,
    label: `Velero ${name}${url ? ` (${url})` : ""}`,
    ...(url ? { url } : {}),
  };
}

// The location a backup or schedule writes to: the one it names, else the
// location marked default.
export function locationName(spec: BackupSpecFields | undefined, locations: VeleroLocation[]): string | undefined {
  return spec?.storageLocation || locations.find((l) => l.spec?.default)?.metadata.name;
}

export function matchesSelector(labels: Record<string, string> | undefined, selector: LabelSelector): boolean {
  const have = labels ?? {};
  for (const [k, v] of Object.entries(selector.matchLabels ?? {})) if (have[k] !== v) return false;
  for (const expr of selector.matchExpressions ?? []) {
    const present = expr.key in have;
    const values = expr.values ?? [];
    switch (expr.operator) {
      case "In":
        if (!present || !values.includes(have[expr.key] ?? "")) return false;
        break;
      case "NotIn":
        if (present && values.includes(have[expr.key] ?? "")) return false;
        break;
      case "Exists":
        if (!present) return false;
        break;
      case "DoesNotExist":
        if (present) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

// Velero's namespace filter: an empty include list means every namespace,
// "*" is a wildcard and glob patterns are allowed in both lists.
const glob = (pattern: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`
  );

export function namespaceIncluded(ns: string, spec: { includedNamespaces?: string[]; excludedNamespaces?: string[] }) {
  const included = spec.includedNamespaces?.length ? spec.includedNamespaces : ["*"];
  if (!included.some((p) => glob(p).test(ns))) return false;
  return !(spec.excludedNamespaces ?? []).some((p) => glob(p).test(ns));
}

const PVC_NAMES = new Set(["persistentvolumeclaims", "persistentvolumeclaim", "pvc", "pvcs"]);
const lower = (list: string[] | undefined) => (list ?? []).map((r) => r.toLowerCase());
const isPvc = (resource: string) => PVC_NAMES.has(resource.split(".")[0] ?? "");

// Whether a resource filter keeps PVCs in the backup or restore at all.
export function keepsPvcs(spec: {
  includedResources?: string[];
  excludedResources?: string[];
  includedNamespaceScopedResources?: string[];
  excludedNamespaceScopedResources?: string[];
}): boolean {
  for (const excluded of [spec.excludedResources, spec.excludedNamespaceScopedResources]) {
    if (lower(excluded).some(isPvc)) return false;
  }
  for (const included of [spec.includedResources, spec.includedNamespaceScopedResources]) {
    if (included?.length && !lower(included).some((r) => r === "*" || isPvc(r))) return false;
  }
  return true;
}

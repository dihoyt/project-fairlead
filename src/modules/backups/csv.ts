import type { BackupPosture, PostureRow } from "../../contracts/backups.js";

const COLUMNS: Array<[string, (row: PostureRow) => string | number | boolean | undefined]> = [
  ["namespace", (r) => r.pvc.namespace],
  ["pvc", (r) => r.pvc.name],
  ["uid", (r) => r.pvc.uid],
  ["app", (r) => r.app],
  ["size_bytes", (r) => r.pvc.sizeBytes],
  ["storage_class", (r) => r.pvc.storageClass],
  ["status", (r) => r.status],
  ["protected", (r) => r.protected],
  ["sources", (r) => [...new Set(r.coverage.map((c) => c.sourceId))].join(" ")],
  ["policy", (r) => r.coverage.map((c) => c.policy.description).join("; ")],
  ["last_good", (r) => r.lastGood?.at],
  ["last_good_ref", (r) => r.lastGood?.ref],
  ["age_status", (r) => r.ageStatus],
  ["age_detail", (r) => r.ageDetail],
  ["target", (r) => r.target?.label],
  ["target_free_bytes", (r) => r.target?.free],
  ["target_total_bytes", (r) => r.target?.total],
  ["restore_tested", (r) => r.restoreTested?.at],
  ["restore_tested_from", (r) => r.restoreTested?.from],
];

// RFC 4180 quoting, plus a leading apostrophe on text a spreadsheet would
// otherwise evaluate as a formula: failure messages and notes come from
// outside and end up opened in Excel.
export function csvCell(value: string | number | boolean | undefined): string {
  if (value === undefined) return "";
  if (typeof value !== "string") return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function postureCsv(posture: BackupPosture): string {
  const lines = [COLUMNS.map(([name]) => name).join(",")];
  for (const row of posture.rows) lines.push(COLUMNS.map(([, get]) => csvCell(get(row))).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

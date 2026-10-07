import { mkdirSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";

// WAL so two pods overlapping in a rollout can share the file; the busy
// timeout absorbs the other pod's short write locks instead of failing.
export function openDatabase(file: string): Database {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new BetterSqlite3(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  return db;
}

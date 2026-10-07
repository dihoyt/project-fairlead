import type { Database } from "better-sqlite3";
import type { Role } from "../../contracts/auth.js";

export type { Role };

export interface UserRow {
  id: number;
  orgId: string;
  username: string;
  displayName: string;
  email: string;
  passwordHash: string | null;
  role: Role;
  disabled: boolean;
  mustChangePassword: boolean;
  allowedNetworks: string[];
  createdAt: number;
  lastLoginAt: number | null;
}

interface RawUser {
  id: number;
  org_id: string;
  username: string;
  display_name: string;
  email: string;
  password_hash: string | null;
  role: Role;
  disabled: number;
  must_change_password: number;
  allowed_networks: string;
  created_at: number;
  last_login_at: number | null;
}

function networks(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function fromRaw(raw: RawUser | undefined): UserRow | null {
  if (raw === undefined) return null;
  return {
    id: raw.id,
    orgId: raw.org_id,
    username: raw.username,
    displayName: raw.display_name,
    email: raw.email,
    passwordHash: raw.password_hash,
    role: raw.role,
    disabled: raw.disabled !== 0,
    mustChangePassword: raw.must_change_password !== 0,
    allowedNetworks: networks(raw.allowed_networks),
    createdAt: raw.created_at,
    lastLoginAt: raw.last_login_at,
  };
}

// The same rule everywhere a username is born, so a name created through
// OIDC and one typed by an admin can never differ only in a character the
// other path would have rejected. Email-shaped names are allowed because
// that is what most providers' preferred_username is.
const USERNAME = /^[a-z0-9][a-z0-9._@-]{0,63}$/;

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function usernameProblem(username: string): string | null {
  return USERNAME.test(username)
    ? null
    : "Usernames are 1–64 characters: lowercase letters, digits, and . _ @ -, starting with a letter or digit.";
}

export function userById(db: Database, id: number): UserRow | null {
  return fromRaw(db.prepare("SELECT * FROM users WHERE id = ?").get(id) as RawUser | undefined);
}

export function userByUsername(db: Database, username: string): UserRow | null {
  return fromRaw(
    db.prepare("SELECT * FROM users WHERE username = ?").get(normalizeUsername(username)) as RawUser | undefined
  );
}

export function listUsers(db: Database): UserRow[] {
  return (db.prepare("SELECT * FROM users ORDER BY username").all() as RawUser[]).map((raw) => fromRaw(raw)!);
}

export function countUsers(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

export function countActiveAdmins(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;
}

export interface NewUser {
  orgId: string;
  username: string;
  displayName?: string;
  email?: string;
  passwordHash: string | null;
  role: Role;
  mustChangePassword?: boolean;
}

export function createUser(db: Database, input: NewUser): UserRow {
  const result = db
    .prepare(
      `INSERT INTO users (org_id, username, display_name, email, password_hash, role, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.orgId,
      normalizeUsername(input.username),
      input.displayName ?? "",
      input.email ?? "",
      input.passwordHash,
      input.role,
      input.mustChangePassword ? 1 : 0,
      Date.now()
    );
  return userById(db, Number(result.lastInsertRowid))!;
}

export interface UserChanges {
  displayName?: string;
  email?: string;
  role?: Role;
  disabled?: boolean;
  allowedNetworks?: string[];
  passwordHash?: string | null;
  mustChangePassword?: boolean;
}

const COLUMNS: Record<keyof UserChanges, string> = {
  displayName: "display_name",
  email: "email",
  role: "role",
  disabled: "disabled",
  allowedNetworks: "allowed_networks",
  passwordHash: "password_hash",
  mustChangePassword: "must_change_password",
};

export function updateUser(db: Database, id: number, changes: UserChanges): UserRow | null {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(COLUMNS) as [keyof UserChanges, string][]) {
    const value = changes[key];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(typeof value === "boolean" ? (value ? 1 : 0) : Array.isArray(value) ? JSON.stringify(value) : value);
  }
  if (sets.length > 0) db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  return userById(db, id);
}

export function recordLogin(db: Database, id: number): void {
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(Date.now(), id);
}

export function deleteUser(db: Database, id: number): void {
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

export interface IdentityRow {
  provider: string;
  subject: string;
  userId: number;
  email: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export function identitiesOf(db: Database, userId: number): IdentityRow[] {
  return db
    .prepare(
      `SELECT provider, subject, user_id AS userId, email, created_at AS createdAt, last_used_at AS lastUsedAt
         FROM identities WHERE user_id = ? ORDER BY created_at`
    )
    .all(userId) as IdentityRow[];
}

export function userByIdentity(db: Database, provider: string, subject: string): UserRow | null {
  const row = db
    .prepare("SELECT user_id AS userId FROM identities WHERE provider = ? AND subject = ?")
    .get(provider, subject) as { userId: number } | undefined;
  return row === undefined ? null : userById(db, row.userId);
}

export function linkIdentity(db: Database, provider: string, subject: string, userId: number, email: string): void {
  db.prepare(
    `INSERT INTO identities (provider, subject, org_id, user_id, email, created_at)
       SELECT ?, ?, org_id, id, ?, ? FROM users WHERE id = ?
       ON CONFLICT(provider, subject) DO UPDATE SET user_id = excluded.user_id, email = excluded.email`
  ).run(provider, subject, email, Date.now(), userId);
}

export function touchIdentity(db: Database, provider: string, subject: string, email: string): void {
  db.prepare("UPDATE identities SET last_used_at = ?, email = ? WHERE provider = ? AND subject = ?").run(
    Date.now(),
    email,
    provider,
    subject
  );
}

export function unlinkIdentities(db: Database, userId: number, provider: string): number {
  return db.prepare("DELETE FROM identities WHERE user_id = ? AND provider = ?").run(userId, provider).changes;
}

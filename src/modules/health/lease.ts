import type { Database } from "better-sqlite3";

// Two pods share the database during every rollout. Only the lease holder
// runs scheduled collections, so providers are not polled twice and a stuck
// old pod hands over once its lease lapses. Correctness doesn't depend on
// it: the store's change detection is transactional, so even two runners
// emit each change once.
export interface Lease {
  readonly holder: string;
  // Renews when held or lapsed; true when this instance holds it afterwards.
  acquire(): boolean;
  // Held, and renewed recently enough that no other pod can have taken it.
  held(): boolean;
}

export function createLease(
  db: Database,
  orgId: string,
  name: string,
  holder: string,
  ttlMs: number,
  now: () => number = Date.now
): Lease {
  const claim = db.prepare(`
    INSERT INTO health_leases (org_id, name, holder, expires_at) VALUES (@org, @name, @holder, @expires)
    ON CONFLICT (org_id, name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
    WHERE health_leases.holder = excluded.holder OR health_leases.expires_at <= @now
  `);
  const current = db.prepare<[string, string], { holder: string; expires_at: number }>(
    "SELECT holder, expires_at FROM health_leases WHERE org_id = ? AND name = ?"
  );
  let heldUntil = 0;

  return {
    holder,
    acquire() {
      const at = now();
      claim.run({ org: orgId, name, holder, expires: at + ttlMs, now: at });
      const row = current.get(orgId, name);
      heldUntil = row?.holder === holder ? row.expires_at : 0;
      return heldUntil > at;
    },
    held: () => heldUntil > now(),
  };
}

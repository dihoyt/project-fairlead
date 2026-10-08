import type { Database } from "better-sqlite3";
import type { CloudflareExposure, CloudflareView } from "../../contracts/connectors.js";
import type { HostPrefs } from "./sync.js";

export class CloudflareStore {
  private readonly db: Database;
  private readonly orgId: string;

  constructor(db: Database, orgId: string) {
    this.db = db;
    this.orgId = orgId;
  }

  prefs(): Map<string, HostPrefs> {
    const rows = this.db
      .prepare("SELECT host, exposure, access FROM connector_cloudflare_hosts WHERE org_id = ?")
      .all(this.orgId) as Array<{ host: string; exposure: string | null; access: number | null }>;
    return new Map(
      rows.map((r) => [
        r.host,
        {
          ...(r.exposure ? { exposure: r.exposure as CloudflareExposure } : {}),
          ...(r.access === null ? {} : { access: r.access === 1 }),
        },
      ])
    );
  }

  setPrefs(host: string, prefs: HostPrefs, by: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO connector_cloudflare_hosts (org_id, host, exposure, access, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (org_id, host) DO UPDATE SET exposure = excluded.exposure, access = excluded.access,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      )
      .run(this.orgId, host, prefs.exposure ?? null, prefs.access === undefined ? null : prefs.access ? 1 : 0, by, at);
  }

  private row() {
    return this.db
      .prepare("SELECT tunnel_id, tunnel_created, view, synced_at FROM connector_cloudflare_state WHERE org_id = ?")
      .get(this.orgId) as
      { tunnel_id: string | null; tunnel_created: number; view: string | null; synced_at: string | null } | undefined;
  }

  private ensure() {
    this.db.prepare("INSERT OR IGNORE INTO connector_cloudflare_state (org_id) VALUES (?)").run(this.orgId);
  }

  tunnel(): { id: string; created: boolean } | undefined {
    const row = this.row();
    return row?.tunnel_id ? { id: row.tunnel_id, created: row.tunnel_created === 1 } : undefined;
  }

  setTunnel(id: string | null, created: boolean): void {
    this.ensure();
    this.db
      .prepare("UPDATE connector_cloudflare_state SET tunnel_id = ?, tunnel_created = ? WHERE org_id = ?")
      .run(id, created ? 1 : 0, this.orgId);
  }

  view(): CloudflareView | undefined {
    const row = this.row();
    return row?.view ? (JSON.parse(row.view) as CloudflareView) : undefined;
  }

  setView(view: CloudflareView): void {
    this.ensure();
    this.db
      .prepare("UPDATE connector_cloudflare_state SET view = ?, synced_at = ? WHERE org_id = ?")
      .run(JSON.stringify(view), view.syncedAt ?? null, this.orgId);
  }

  clear(): void {
    this.db.prepare("DELETE FROM connector_cloudflare_state WHERE org_id = ?").run(this.orgId);
  }
}

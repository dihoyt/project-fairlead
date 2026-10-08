import { randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";
import { CATEGORIES } from "../../contracts/health.js";
import type { Category, HealthLinkRequest, HealthLinkView } from "../../contracts/health.js";
import type { Setting } from "../../contracts/platform.js";
import { HttpError } from "../../runtime/http.js";
import type { CategoryLinks } from "./settings.js";

interface RawLink {
  id: string;
  category: Category;
  label: string;
  url: string;
  created_by: string;
  created_at: string;
}

export interface LinkStore {
  list(category?: Category): HealthLinkView[];
  create(input: unknown, actor: string): HealthLinkView;
  update(id: string, input: unknown): HealthLinkView;
  remove(id: string): HealthLinkView;
  // Deletes every custom link; returns how many.
  clear(): number;
}

function category(value: unknown): Category {
  if (typeof value !== "string" || !CATEGORIES.includes(value as Category)) {
    throw new HttpError(400, `Category must be one of ${CATEGORIES.join(", ")}.`);
  }
  return value as Category;
}

function label(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 80) throw new HttpError(400, "Label must be 1 to 80 characters.");
  return text;
}

function url(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new HttpError(400, "URL must be an absolute http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, "URL must be an absolute http(s) URL.");
  }
  return text;
}

const view = (raw: RawLink): HealthLinkView => ({
  id: raw.id,
  category: raw.category,
  label: raw.label,
  url: raw.url,
  source: "custom",
  createdBy: raw.created_by,
  createdAt: raw.created_at,
});

// Settings links are the wizard's (health.links); custom links live in
// their own table so the API can change them without touching a setting.
export function createLinkStore(db: Database, orgId: string, settingLinks: Setting<CategoryLinks>): LinkStore {
  const byId = (id: string): RawLink => {
    if (id.startsWith("settings:")) {
      throw new HttpError(409, "That link comes from settings: change it in the Links step or under Admin > Settings.");
    }
    const raw = db.prepare("SELECT * FROM health_links WHERE org_id = ? AND id = ?").get(orgId, id) as
      RawLink | undefined;
    if (!raw) throw new HttpError(404, `No link "${id}".`);
    return raw;
  };

  return {
    list(only) {
      const fromSettings = settingLinks.get();
      const out: HealthLinkView[] = [];
      for (const cat of CATEGORIES) {
        if (only && cat !== only) continue;
        (fromSettings[cat] ?? []).forEach((link, index) =>
          out.push({
            id: `settings:${cat}:${index}`,
            category: cat,
            label: link.label,
            url: link.url,
            source: "settings",
          })
        );
      }
      const rows = (
        only
          ? db
              .prepare("SELECT * FROM health_links WHERE org_id = ? AND category = ? ORDER BY created_at, id")
              .all(orgId, only)
          : db.prepare("SELECT * FROM health_links WHERE org_id = ? ORDER BY created_at, id").all(orgId)
      ) as RawLink[];
      return [...out, ...rows.map(view)];
    },
    create(input, actor) {
      const body = (input ?? {}) as Partial<HealthLinkRequest>;
      const raw: RawLink = {
        id: `lnk_${randomBytes(6).toString("base64url")}`,
        category: category(body.category),
        label: label(body.label),
        url: url(body.url),
        created_by: actor,
        created_at: new Date().toISOString(),
      };
      db.prepare(
        "INSERT INTO health_links (id, org_id, category, label, url, created_by, created_at) VALUES (@id, ?, @category, @label, @url, @created_by, @created_at)"
      ).run(orgId, raw);
      return view(raw);
    },
    update(id, input) {
      const raw = byId(id);
      const body = (input ?? {}) as Partial<HealthLinkRequest>;
      const next: RawLink = {
        ...raw,
        ...(body.category !== undefined ? { category: category(body.category) } : {}),
        ...(body.label !== undefined ? { label: label(body.label) } : {}),
        ...(body.url !== undefined ? { url: url(body.url) } : {}),
      };
      db.prepare("UPDATE health_links SET category = ?, label = ?, url = ? WHERE org_id = ? AND id = ?").run(
        next.category,
        next.label,
        next.url,
        orgId,
        id
      );
      return view(next);
    },
    clear() {
      return db.prepare("DELETE FROM health_links WHERE org_id = ?").run(orgId).changes;
    },
    remove(id) {
      const raw = byId(id);
      db.prepare("DELETE FROM health_links WHERE org_id = ? AND id = ?").run(orgId, id);
      return view(raw);
    },
  };
}

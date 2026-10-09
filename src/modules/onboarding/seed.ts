import type { Request } from "express";
import { RESOURCES, type K8sApi, type KubeObject } from "../../contracts/k8s.js";
import type { ModuleContext } from "../../contracts/module.js";
import {
  INSTALL_SEED_SECRET,
  SEED_ITEM_LABELS,
  type InstallSeed,
  type InstallSeedView,
  type SeedItemId,
  type SeedItemResult,
} from "../../contracts/onboarding.js";
import type { SignInService } from "../../contracts/platform.js";
import { product } from "../../product.js";
import { HttpError } from "../../runtime/http.js";
import { parseSeed, seedEnvFromSecret } from "./seedParse.js";

export const SEED_SCOPE = "onboarding:seed";
const SEED_ID = "values";
const ACTOR = "onboarding";
// A claim on /apply older than this is from a pod that went away mid-run.
const APPLY_CLAIM_MS = 10 * 60_000;

const ORDER: readonly SeedItemId[] = [
  "admin-password",
  "public-url",
  "oidc",
  "cloudflare",
  "entra",
  "storage-target",
  "email",
  "bundle",
];
const AT_BOOT = new Set<SeedItemId>(["admin-password", "public-url", "oidc"]);
const WAITING = "Waiting for the first admin to sign in.";

interface Row {
  imported_at: string;
  applied_at: string | null;
  applied_by: string | null;
  applying_since: number | null;
  dismissed: number;
  items: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const now = () => new Date().toISOString();

const result = (id: SeedItemId, state: SeedItemResult["state"], detail: string): SeedItemResult => ({
  id,
  label: SEED_ITEM_LABELS[id],
  state,
  detail,
  ...(state === "pending" ? {} : { at: now() }),
});

// Which items a parsed file asks for, in apply order.
function wanted(seed: InstallSeed, problems: Partial<Record<SeedItemId, string>>): SeedItemId[] {
  const present: Record<SeedItemId, boolean> = {
    "admin-password": seed.adminPassword !== undefined,
    "public-url": seed.publicUrl !== undefined,
    oidc: seed.oidc !== undefined,
    cloudflare: seed.cloudflare !== undefined,
    entra: seed.entra !== undefined,
    "storage-target": seed.storageTarget !== undefined,
    email: seed.smtp !== undefined,
    bundle: seed.bundle !== undefined,
  };
  return ORDER.filter((id) => present[id] || problems[id] !== undefined);
}

export function createSeedStore(ctx: Pick<ModuleContext, "db" | "orgId">) {
  const read = ctx.db.prepare<[string], Row>(
    `SELECT imported_at, applied_at, applied_by, applying_since, dismissed, items
     FROM onboarding_seed WHERE org_id = ?`
  );
  return {
    row: (): Row | undefined => read.get(ctx.orgId),
    // False when another pod got there first.
    insert(items: SeedItemResult[]): boolean {
      return (
        ctx.db
          .prepare("INSERT OR IGNORE INTO onboarding_seed (org_id, imported_at, items) VALUES (?, ?, ?)")
          .run(ctx.orgId, now(), JSON.stringify(items)).changes === 1
      );
    },
    saveItems(items: SeedItemResult[]): void {
      ctx.db.prepare("UPDATE onboarding_seed SET items = ? WHERE org_id = ?").run(JSON.stringify(items), ctx.orgId);
    },
    claim(): boolean {
      const at = Date.now();
      return (
        ctx.db
          .prepare(
            `UPDATE onboarding_seed SET applying_since = ?
             WHERE org_id = ? AND (applying_since IS NULL OR applying_since < ?)`
          )
          .run(at, ctx.orgId, at - APPLY_CLAIM_MS).changes === 1
      );
    },
    finish(by: string | null): void {
      ctx.db
        .prepare(
          `UPDATE onboarding_seed SET applying_since = NULL,
             applied_at = COALESCE(?, applied_at), applied_by = COALESCE(?, applied_by) WHERE org_id = ?`
        )
        .run(by === null ? null : now(), by, ctx.orgId);
    },
    dismiss(): void {
      ctx.db.prepare("UPDATE onboarding_seed SET dismissed = 1 WHERE org_id = ?").run(ctx.orgId);
    },
    clear(): number {
      return ctx.db.prepare("DELETE FROM onboarding_seed WHERE org_id = ?").run(ctx.orgId).changes;
    },
  };
}

export type SeedStore = ReturnType<typeof createSeedStore>;

export function seedView(row: Row | undefined): InstallSeedView {
  if (!row) return { state: "none", items: [], dismissed: false };
  const items = JSON.parse(row.items) as SeedItemResult[];
  return {
    state: items.some((item) => item.state === "pending") ? "pending" : "done",
    importedAt: row.imported_at,
    ...(row.applied_at ? { appliedAt: row.applied_at } : {}),
    ...(row.applied_by ? { appliedBy: row.applied_by } : {}),
    items,
    dismissed: row.dismissed === 1,
  };
}

async function bootItem(id: SeedItemId, seed: InstallSeed, signin: SignInService): Promise<SeedItemResult> {
  try {
    switch (id) {
      case "admin-password":
        return (await signin.seedAdminPassword(seed.adminPassword!, ACTOR))
          ? result(id, "applied", "Set the admin password from the file; no change is asked at first sign-in.")
          : result(id, "skipped", "The admin account had already signed in, so its password was left as it was.");
      case "public-url":
        await signin.setPublicUrl(seed.publicUrl!, ACTOR);
        return result(id, "applied", `Public URL set to ${seed.publicUrl!.replace(/\/+$/, "")}.`);
      case "oidc": {
        const { issuer, clientId, clientSecret, label, adminGroups } = seed.oidc!;
        await signin.setOidcClient({ issuer, clientId, clientSecret, label, adminGroups, enabled: true }, ACTOR);
        return result(id, "applied", `Sign-in through ${issuer} is on.`);
      }
      default:
        return result(id, "pending", WAITING);
    }
  } catch (err) {
    const why = message(err);
    return result(id, /set by the environment/.test(why) ? "skipped" : "failed", why);
  }
}

// Reads the seed Secret once: seals what /apply needs, applies the boot
// items, then deletes the Secret. "absent": there is no Secret (now or
// any more), so there is nothing left for this to do.
export async function importSeed(
  ctx: Pick<ModuleContext, "secrets" | "audit" | "log">,
  store: SeedStore,
  k8s: K8sApi,
  signin: SignInService,
  namespace: string
): Promise<"imported" | "absent" | "kept"> {
  const secret = await k8s.get<KubeObject & { data?: Record<string, string> }>(
    RESOURCES.secrets,
    INSTALL_SEED_SECRET.name,
    namespace
  );
  if (secret === null || secret === "absent") return "absent";

  let outcome: "imported" | "kept" = "kept";
  if (!store.row()) {
    const { seed, problems } = parseSeed(seedEnvFromSecret(secret.data));
    const ids = wanted(seed, problems);
    let items = ids.map((id) =>
      problems[id] ? result(id, "failed", problems[id]) : result(id, "pending", AT_BOOT.has(id) ? "Applying." : WAITING)
    );
    const later = ids.some((id) => !AT_BOOT.has(id) && !problems[id]);
    if (store.insert(items)) {
      outcome = "imported";
      if (later) {
        const kept: InstallSeed = structuredClone(seed);
        if (kept.bundle && !kept.authentikBootstrapPassword && kept.adminPassword)
          kept.authentikBootstrapPassword = kept.adminPassword;
        delete kept.adminPassword;
        delete kept.publicUrl;
        delete kept.oidc;
        try {
          await ctx.secrets.put(SEED_SCOPE, SEED_ID, JSON.stringify(kept));
        } catch (err) {
          const why = `The file's values could not be kept for later: ${message(err)}`;
          items = items.map((item) =>
            item.state === "pending" && !AT_BOOT.has(item.id) ? result(item.id, "failed", why) : item
          );
          store.saveItems(items);
        }
      }
      for (const [index, item] of items.entries()) {
        if (!AT_BOOT.has(item.id) || item.state !== "pending") continue;
        items[index] = await bootItem(item.id, seed, signin);
        store.saveItems(items);
      }
      ctx.audit.record({
        actor: ACTOR,
        action: "onboarding.seed-import",
        target: INSTALL_SEED_SECRET.name,
        detail: items.map((item) => `${item.id}=${item.state}`).join(" "),
      });
      ctx.log.info("Read the install seed", { items: items.map((item) => `${item.id}=${item.state}`) });
    }
  }
  if (!k8s.delete) throw new Error("This build cannot delete the install seed Secret.");
  await k8s.delete(RESOURCES.secrets, INSTALL_SEED_SECRET.name, namespace);
  return outcome;
}

type Call = ModuleContext["call"];

async function applyItem(id: SeedItemId, seed: InstallSeed, call: Call, req: Request): Promise<SeedItemResult> {
  switch (id) {
    case "cloudflare": {
      const cf = seed.cloudflare!;
      const existing = (await call(req, "GET /api/connectors")).find((c) => c.kind === "cloudflare");
      if (existing) return result(id, "skipped", `A Cloudflare connector already exists (${existing.name}).`);
      let accountId = cf.accountId;
      if (!accountId) {
        const seen = await call(req, "POST /api/connector-cloudflare/discover", { body: { token: cf.token } });
        accountId = seen.zones.find((zone) => zone.name === cf.zone)?.accountId;
        if (!accountId && seen.accounts.length === 1) accountId = seen.accounts[0]!.id;
        if (!accountId)
          return result(
            id,
            "failed",
            `The token sees ${seen.accounts.length} accounts and none holds zone ${cf.zone}; set CLOUDFLARE_ACCOUNT_ID.`
          );
      }
      await call(req, "POST /api/connectors", {
        body: { kind: "cloudflare", name: "Cloudflare", values: { apiToken: cf.token, accountId, zone: cf.zone } },
      });
      if (cf.accessApps)
        await call(req, "PUT /api/admin/settings/:key", {
          params: { key: "connector-cloudflare.accessApps" },
          body: { value: cf.accessApps },
        });
      try {
        const view = await call(req, "GET /api/connector-cloudflare/view");
        if (!view.tunnel) {
          const old = view.existingTunnels?.find((tunnel) => tunnel.name === product.slug);
          await call(req, "POST /api/connector-cloudflare/tunnel", { body: old ? { tunnelId: old.id } : {} });
        }
        await call(req, "POST /api/connector-cloudflare/tunnel/deploy");
        await call(req, "POST /api/connector-cloudflare/sync");
      } catch (err) {
        return result(
          id,
          "failed",
          `Created the Cloudflare connector for ${cf.zone}, but its tunnel did not start: ${message(err)} Finish it on the Cloudflare page.`
        );
      }
      return result(id, "applied", `Created the Cloudflare connector for ${cf.zone} and started its tunnel.`);
    }
    case "entra": {
      const entra = seed.entra!;
      const existing = (await call(req, "GET /api/connectors")).find((c) => c.kind === "entra");
      if (existing) return result(id, "skipped", `An Entra ID connector already exists (${existing.name}).`);
      await call(req, "POST /api/connectors", {
        body: {
          kind: "entra",
          name: "Microsoft Entra ID",
          values: { tenantId: entra.tenantId, clientId: entra.clientId, clientSecret: entra.clientSecret },
        },
      });
      try {
        await call(req, "POST /api/connector-entra/signin", {
          body: entra.adminGroups ? { adminGroups: entra.adminGroups } : {},
        });
      } catch (err) {
        return result(
          id,
          "failed",
          `Created the Entra ID connector, but sign-in through it was not set up: ${message(err)}`
        );
      }
      return result(
        id,
        "applied",
        "Created the Entra ID connector and turned on sign-in through its app registration."
      );
    }
    case "storage-target": {
      const target = seed.storageTarget!;
      const s3 = target.protocol === "s3";
      const smb = target.protocol === "smb";
      const host = /^[a-z0-9]+:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(target.url)?.[1] ?? target.url;
      const view = await call(req, "POST /api/connectors", {
        body: {
          kind: "storage-target",
          name: host,
          values: {
            protocol: target.protocol,
            url: target.url,
            path: target.path ?? "",
            endpoint: s3 ? (target.endpoint ?? "") : "",
            accessKeyId: s3 ? (target.user ?? "") : "",
            secretAccessKey: s3 ? (target.secret ?? "") : "",
            username: smb ? (target.user ?? "") : "",
            password: smb ? (target.secret ?? "") : "",
          },
        },
      });
      const tested = await call(req, "POST /api/connectors/:id/test", { params: { id: view.id } }).catch(() => view);
      const bad = tested.checks.find((check) => check.status === "crit");
      if (bad) return result(id, "failed", `Created the storage target ${host}, but ${bad.label}: ${bad.detail}`);
      return result(id, "applied", `Created the storage target ${host} (${target.protocol.toUpperCase()}).`);
    }
    case "email": {
      const smtp = seed.smtp!;
      const channel = await call(req, "POST /api/notify/channels", {
        body: {
          kind: "email",
          label: "Email",
          config: {
            email: {
              preset: smtp.preset,
              ...(smtp.host ? { host: smtp.host } : {}),
              ...(smtp.port ? { port: smtp.port } : {}),
              ...(smtp.security ? { security: smtp.security } : {}),
              ...(smtp.user ? { username: smtp.user } : {}),
              from: smtp.from,
              to: smtp.to,
            },
          },
          ...(smtp.password ? { secret: smtp.password } : {}),
        },
      });
      const sent = await call(req, "POST /api/notify/channels/:id/test", { params: { id: channel.id } });
      if (!sent.ok)
        return result(
          id,
          "failed",
          `Created the email channel, but the test mail failed: ${sent.error ?? "no reason given"}`
        );
      return result(id, "applied", `Created the email channel and sent a test mail to ${smtp.to.join(", ")}.`);
    }
    case "bundle": {
      const bundle = seed.bundle!;
      const [view] = await call(req, "GET /api/catalog/bundles");
      if (!view) return result(id, "failed", "This build has no Deploy bundle.");
      const optional = view.items.filter((item) => !item.required).map((item) => item.appId);
      if (bundle.include !== "default") {
        const unknown = bundle.include.filter((appId) => !optional.includes(appId));
        if (unknown.length)
          return result(
            id,
            "failed",
            `BUNDLE names ${unknown.join(", ")}, which the bundle doesn't offer as optional (it offers ${optional.join(", ") || "none"}).`
          );
      }
      const run = await call(req, "POST /api/deploy/bundles", {
        body: {
          bundleId: view.id,
          inputs: {
            access: bundle.access ?? "local",
            ...(bundle.access === "cloudflare-tunnel" ? { cloudflareSetup: "api" } : {}),
            baseDomain: bundle.baseDomain ?? "",
            adminEmail: bundle.adminEmail ?? "",
            adminPassword: seed.authentikBootstrapPassword ?? "",
            ...(bundle.storageClass ? { storageClass: bundle.storageClass } : {}),
          },
          ...(bundle.include === "default" ? {} : { include: bundle.include }),
        },
      });
      const ticked =
        bundle.include === "default" ? "its default choices" : bundle.include.join(", ") || "no optional apps";
      return result(id, "applied", `Started the ${view.name} with ${ticked} (run ${run.id}).`);
    }
    default:
      // A boot item still pending: the pod stopped before it ran, and its
      // value was never kept for later.
      return result(id, "failed", "The console restarted before applying this at first boot; set it in Admin.");
  }
}

// Applies every pending item as the caller of `req`, one after another.
export async function applySeed(
  ctx: Pick<ModuleContext, "secrets" | "audit" | "call" | "log">,
  store: SeedStore,
  req: Request,
  actor: string
): Promise<InstallSeedView> {
  if (!store.row()) return seedView(undefined);
  if (seedView(store.row()).state !== "pending") return seedView(store.row());
  if (!store.claim()) throw new HttpError(409, "The file's settings are being applied already.");
  try {
    const items = seedView(store.row()).items;
    const raw = await ctx.secrets.get(SEED_SCOPE, SEED_ID).catch(() => null);
    const seed = raw === null ? null : (JSON.parse(raw) as InstallSeed);
    for (const [index, item] of items.entries()) {
      if (item.state !== "pending") continue;
      if (seed === null) {
        items[index] = result(item.id, "failed", "The file's values are no longer stored (was SECRETS_KEY changed?).");
      } else {
        try {
          items[index] = await applyItem(item.id, seed, ctx.call, req);
        } catch (err) {
          items[index] = result(item.id, "failed", message(err));
        }
      }
      store.saveItems(items);
    }
    await ctx.secrets.delete(SEED_SCOPE, SEED_ID).catch((err: unknown) => {
      ctx.log.warn("Could not delete the stored install seed", { error: message(err) });
    });
    store.finish(actor);
    ctx.audit.record({
      actor,
      action: "onboarding.seed-apply",
      target: INSTALL_SEED_SECRET.name,
      detail: items.map((item) => `${item.id}=${item.state}`).join(" "),
    });
  } catch (err) {
    store.finish(null);
    throw err;
  }
  return seedView(store.row());
}

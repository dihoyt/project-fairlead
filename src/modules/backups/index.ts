import type { Request } from "express";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { z } from "zod";
import type { BackupPosture, PostureRow, RestoreTestMark } from "../../contracts/backups.js";
import type { CheckResult } from "../../contracts/health.js";
import type { Module, ModuleContext } from "../../contracts/module.js";
import { HttpError } from "../../runtime/http.js";
import { listPvcs, type ClusterPvc, type SelfPod } from "./cluster.js";
import { postureCsv } from "./csv.js";
import { migrations } from "./migrations.js";
import { buildPosture, targetsOf, type SourceOutcome } from "./posture.js";
import { declareSettings, readOptions, type BackupsSettings } from "./settings.js";
import { createStore, type Store } from "./store.js";

export const HEALTH_INTERVAL_MS = 60_000;
// Page loads within this window share one gathering of every source.
export const CACHE_MS = 15_000;
// Below the health provider's interval, which is its collect() timeout.
export const SOURCE_TIMEOUT_MS = 20_000;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function withTimeout<T>(promise: Promise<T>, what: string, ms = SOURCE_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The PVC list is what everything else is judged against, so without it
// there is no posture to show, only the reason.
export class PvcListError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

const SA_NAMESPACE = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";

// Only the image's own pod: a dev server in some other pod (code-server, say)
// has a hostname and service account too, and must not claim that pod's
// volumes as its own.
export function selfPod(env: NodeJS.ProcessEnv = process.env): SelfPod | undefined {
  if (env.NODE_ENV !== "production") return undefined;
  try {
    const namespace = readFileSync(SA_NAMESPACE, "utf8").trim();
    return namespace ? { name: env.HOSTNAME || hostname(), namespace } : undefined;
  } catch {
    return undefined;
  }
}

export interface PostureService {
  get(maxAgeMs?: number): Promise<BackupPosture>;
  pvcs(): Promise<ClusterPvc[]>;
  invalidate(): void;
}

export function createPostureService(
  ctx: ModuleContext,
  store: Store,
  settings: BackupsSettings,
  now: () => number = Date.now,
  self: SelfPod | undefined = selfPod()
): PostureService {
  async function pvcs(): Promise<ClusterPvc[]> {
    if (!ctx.services.has("k8s")) throw new PvcListError(503, "The Kubernetes API is not available.");
    try {
      return await withTimeout(listPvcs(ctx.services.get("k8s"), self), "The Kubernetes API");
    } catch (err) {
      throw new PvcListError(502, `Could not list PVCs: ${message(err)}`);
    }
  }

  async function gather(): Promise<BackupPosture> {
    const [clusterPvcs, sources] = await Promise.all([
      pvcs(),
      Promise.all(
        ctx.backups.sources().map(async (source): Promise<SourceOutcome> => {
          try {
            const volumes = await withTimeout(source.list(), source.label);
            return {
              id: source.id,
              label: source.label,
              result: volumes === "absent" ? { state: "absent" } : { state: "ok", volumes },
            };
          } catch (err) {
            ctx.log.warn("Backup source failed", { source: source.id, error: message(err) });
            return { id: source.id, label: source.label, result: { state: "error", error: message(err) } };
          }
        })
      ),
    ]);

    const capacity = new Map<string, { free: number; total: number }>();
    await Promise.all(
      targetsOf(sources).map(async (target) => {
        const match = ctx.backups.capacities().find((c) => {
          try {
            return c.targetMatch(target);
          } catch {
            return false;
          }
        });
        if (!match) return;
        try {
          capacity.set(target.id, await withTimeout(match.freeBytes(), `Capacity for ${target.label}`));
        } catch (err) {
          ctx.log.warn("Backup target capacity failed", { target: target.id, error: message(err) });
        }
      })
    );

    return buildPosture({
      pvcs: clusterPvcs,
      sources,
      capacity,
      marks: store.latest(),
      now: now(),
      options: readOptions(settings),
    });
  }

  let cached: { at: number; posture: BackupPosture } | undefined;
  let inFlight: Promise<BackupPosture> | undefined;

  return {
    pvcs,
    async get(maxAgeMs = CACHE_MS) {
      if (cached && now() - cached.at < maxAgeMs) return cached.posture;
      if (!inFlight) {
        const startedAt = now();
        inFlight = gather()
          .then((posture) => {
            cached = { at: startedAt, posture };
            return posture;
          })
          .finally(() => {
            inFlight = undefined;
          });
      }
      return inFlight;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

const label = (row: PostureRow) => `${row.pvc.namespace}/${row.pvc.name}`;

// The app that mounts the volume is what a person goes to fix, so it is the
// check's object; with several, the first, and with none, the claim itself.
export function objectOf(row: PostureRow): NonNullable<CheckResult["object"]> {
  const first = row.app?.split(", ")[0];
  const slash = first?.indexOf("/") ?? -1;
  if (first && slash > 0) {
    return { kind: first.slice(0, slash), namespace: row.pvc.namespace, name: first.slice(slash + 1) };
  }
  return { kind: "PersistentVolumeClaim", namespace: row.pvc.namespace, name: row.pvc.name };
}

// One result per PVC, so the Backups tile counts volumes, plus one per
// source that failed to answer.
export function healthResults(posture: BackupPosture): CheckResult[] {
  const observedAt = posture.generatedAt;
  const results: CheckResult[] = posture.sources
    .filter((s) => s.state === "error")
    .map((s) => ({
      id: `source/${s.id}`,
      label: `${s.label} backups`,
      status: "unknown",
      detail: `Could not read ${s.label}: ${s.error ?? "unknown error"}`,
      raw: s,
      observedAt,
    }));

  if (posture.rows.length === 0) {
    results.push({
      id: "pvcs",
      label: "PersistentVolumeClaims",
      status: "ok",
      detail: "No PVCs in the cluster",
      observedAt,
    });
  }

  for (const row of posture.rows) {
    const space =
      row.target?.free !== undefined && row.target.total
        ? Math.round((row.target.free / row.target.total) * 100)
        : null;
    const lowSpace = row.status !== row.ageStatus && space !== null ? `; target ${space}% free` : "";
    const ageHours = row.lastGood ? (Date.parse(observedAt) - Date.parse(row.lastGood.at)) / 3_600_000 : undefined;
    results.push({
      id: `pvc/${row.pvc.namespace}/${row.pvc.name}`,
      label: label(row),
      status: row.status,
      ...(ageHours !== undefined ? { value: Math.round(ageHours * 10) / 10 } : {}),
      detail: `${row.ageDetail}${lowSpace}`,
      object: objectOf(row),
      ...(row.status === "ok" || row.status === "absent"
        ? {}
        : {
            raw: {
              pvc: row.pvc,
              app: row.app,
              coverage: row.coverage.map((c) => ({
                sourceId: c.sourceId,
                policy: c.policy,
                lastGood: c.lastGood,
                lastAttempt: c.lastAttempt,
                target: c.target,
              })),
              target: row.target,
            },
          }),
      observedAt,
    });
  }
  return results;
}

const restoreTestBody = z.object({
  at: z.iso.datetime({ offset: true }).or(z.iso.date()),
  note: z.string().trim().max(1000).default(""),
});

function register(ctx: ModuleContext): void {
  const store = createStore(ctx.db, ctx.orgId);
  const settings = declareSettings(ctx.settings);
  const service = createPostureService(ctx, store, settings);

  ctx.health.addProvider({
    id: "backups",
    category: "backups",
    label: "Backup posture",
    intervalMs: HEALTH_INTERVAL_MS,
    async collect() {
      try {
        return healthResults(await service.get(0));
      } catch (err) {
        return [
          {
            id: "pvcs",
            label: "PersistentVolumeClaims",
            status: "unknown",
            detail: message(err),
            raw: { error: message(err) },
            observedAt: new Date().toISOString(),
          },
        ];
      }
    },
  });

  const posture = async () => {
    try {
      return await service.get();
    } catch (err) {
      if (err instanceof PvcListError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };

  // A token limited to some namespaces sees only their volumes.
  const visiblePosture = async (req: Request) => {
    const current = await posture();
    const allowed = ctx.visibleNamespaces(req);
    if (allowed === null) return current;
    return { ...current, rows: current.rows.filter((row) => allowed.includes(row.pvc.namespace)) };
  };

  ctx.route("GET /api/backups/posture", (req) => visiblePosture(req));

  ctx.route("GET /api/backups/posture.csv", async (req, res) => {
    const current = await visiblePosture(req);
    const day = current.generatedAt.slice(0, 10);
    res
      .status(200)
      .type("text/csv; charset=utf-8")
      .set("Content-Disposition", `attachment; filename="backup-posture-${day}.csv"`)
      .send(postureCsv(current));
    return undefined;
  });

  ctx.route("POST /api/backups/volumes/:uid/restore-tests", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    const parsed = restoreTestBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")
      );
    }
    const at = Date.parse(parsed.data.at);
    if (Number.isNaN(at)) throw new HttpError(400, "at: Invalid date");
    if (at > Date.now() + 86_400_000) throw new HttpError(400, "at: A restore test cannot be in the future.");

    let pvcs: ClusterPvc[];
    try {
      pvcs = await service.pvcs();
    } catch (err) {
      if (err instanceof PvcListError) throw new HttpError(err.status, err.message);
      throw err;
    }
    const pvc = pvcs.find((p) => p.ref.uid === req.params.uid);
    if (!pvc) throw new HttpError(404, "No such PVC.");

    const mark: RestoreTestMark = { at: new Date(at).toISOString(), note: parsed.data.note, by: user.id };
    store.insert(pvc.ref, mark, new Date().toISOString());
    service.invalidate();
    ctx.audit.record({
      actor: user.id,
      action: "backups.mark-restore-tested",
      target: `${pvc.ref.namespace}/${pvc.ref.name}`,
      detail: mark.note ? `${mark.at}: ${mark.note}` : mark.at,
    });
    return mark;
  });
}

const mod: Module = {
  id: "backups",
  milestone: "A",
  migrations,
  register,
};

export default mod;

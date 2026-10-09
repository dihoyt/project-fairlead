import type { Request } from "express";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { z } from "zod";
import type {
  BackupPosture,
  BackupSchedulesView,
  BackupTargetView,
  PostureRow,
  RestoreTestMark,
} from "../../contracts/backups.js";
import type { DeployActionRequest } from "../../contracts/deploy.js";
import type { CheckResult } from "../../contracts/health.js";
import type { Module, ModuleContext } from "../../contracts/module.js";
import { HttpError } from "../../runtime/http.js";
import { listPvcs, type ClusterPvc, type SelfPod } from "./cluster.js";
import { registerConsoleRoutes } from "./console.js";
import { readSchedules, readTarget, readVolumes, restorePoints, type LonghornVolumes } from "./longhorn.js";
import { postureCsv } from "./csv.js";
import { migrations } from "./migrations.js";
import { buildPosture, setUpPosture, targetsOf, type SourceOutcome } from "./posture.js";
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

    const posture = buildPosture({
      pvcs: clusterPvcs,
      sources,
      capacity,
      marks: store.latest(),
      now: now(),
      options: readOptions(settings),
    });
    return setUpPosture(posture, await longhornSetUp());
  }

  // Longhorn's side of the set-up; best effort, the posture stands without it.
  async function longhornSetUp(): Promise<{
    target?: BackupTargetView;
    schedules?: BackupSchedulesView;
    volumes?: LonghornVolumes;
  }> {
    if (!ctx.services.has("k8s")) return {};
    const k8s = ctx.services.get("k8s");
    const targets = ctx.services.has("storage-targets") ? ctx.services.get("storage-targets") : undefined;
    const settled = await Promise.allSettled([
      withTimeout(readTarget(k8s, targets), "Longhorn's backup target"),
      withTimeout(readSchedules(k8s), "Longhorn's recurring jobs"),
      withTimeout(readVolumes(k8s), "Longhorn's volumes"),
    ]);
    for (const r of settled) {
      if (r.status === "rejected") ctx.log.warn("Longhorn set-up read failed", { error: message(r.reason) });
    }
    const [target, schedules, volumes] = settled.map((r) => (r.status === "fulfilled" ? r.value : undefined)) as [
      BackupTargetView | undefined,
      BackupSchedulesView | undefined,
      LonghornVolumes | "absent" | undefined,
    ];
    return {
      ...(target && target.longhorn === "installed" ? { target } : {}),
      ...(schedules && schedules.longhorn === "installed" ? { schedules } : {}),
      ...(volumes && volumes !== "absent" ? { volumes } : {}),
    };
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

  const k8s = () => {
    if (!ctx.services.has("k8s")) throw new HttpError(503, "The Kubernetes API is not available.");
    return ctx.services.get("k8s");
  };
  const pvcByUid = async (uid: string): Promise<ClusterPvc> => {
    let pvcs: ClusterPvc[];
    try {
      pvcs = await service.pvcs();
    } catch (err) {
      if (err instanceof PvcListError) throw new HttpError(err.status, err.message);
      throw err;
    }
    const pvc = pvcs.find((p) => p.ref.uid === uid);
    if (!pvc) throw new HttpError(404, "No such PVC.");
    return pvc;
  };
  const longhornVolume = async (pvc: ClusterPvc) => {
    const volumes = await readVolumes(k8s());
    const found = volumes === "absent" ? undefined : volumes.byClaim.get(`${pvc.ref.namespace}/${pvc.ref.name}`);
    if (!found) throw new HttpError(404, `${pvc.ref.namespace}/${pvc.ref.name} is not on Longhorn.`);
    return found;
  };
  // Every set-up change is a deploy action started as the caller, so its
  // permission, audit and job log are the deploy module's.
  const runAction = async (req: Parameters<typeof ctx.call>[0], body: DeployActionRequest) => {
    const job = await ctx.call(req, "POST /api/deploy/actions/run", { body });
    service.invalidate();
    return job;
  };
  const restoreRequest = async (body: unknown): Promise<DeployActionRequest> => {
    const r = parse(restoreBody, body);
    const pvc = await pvcByUid(r.uid);
    return {
      kind: "longhorn-restore",
      namespace: pvc.ref.namespace,
      claim: pvc.ref.name,
      backup: r.backupId,
      mode: r.mode,
      ...(r.mode === "new-pvc" ? { newClaim: r.newClaim || defaultRestoreClaim(pvc.ref.name) } : {}),
    };
  };

  ctx.route("GET /api/backups/target", () =>
    readTarget(k8s(), ctx.services.has("storage-targets") ? ctx.services.get("storage-targets") : undefined)
  );

  ctx.route("PUT /api/backups/target", async (req, res) => {
    if (!ctx.require(req, res, "write")) return undefined;
    const { connectorId } = parse(targetBody, req.body);
    if (connectorId !== null) {
      if (!ctx.services.has("storage-targets")) throw new HttpError(503, "Storage targets are not available.");
      if (!(await ctx.services.get("storage-targets").get(connectorId))) {
        throw new HttpError(404, `No storage target "${connectorId}".`);
      }
    }
    return runAction(req, { kind: "longhorn-target", connectorId });
  });

  ctx.route("GET /api/backups/schedules", () => readSchedules(k8s()));

  ctx.route("PUT /api/backups/schedules", async (req, res) => {
    if (!ctx.require(req, res, "write")) return undefined;
    const { schedules } = parse(schedulesBody, req.body);
    return runAction(req, { kind: "longhorn-recurring", schedules });
  });

  ctx.route("PUT /api/backups/volumes/:uid/groups", async (req, res) => {
    if (!ctx.require(req, res, "write")) return undefined;
    const { groups } = parse(pvcBody, req.body);
    const pvc = await pvcByUid(req.params.uid);
    await longhornVolume(pvc);
    return runAction(req, {
      kind: "longhorn-recurring",
      volumes: [{ namespace: pvc.ref.namespace, claim: pvc.ref.name, groups: [...new Set(groups)] }],
    });
  });

  ctx.route("POST /api/backups/volumes/:uid/backup-now", async (req, res) => {
    if (!ctx.require(req, res, "write")) return undefined;
    const pvc = await pvcByUid(req.params.uid);
    await longhornVolume(pvc);
    return runAction(req, { kind: "longhorn-backup-now", namespace: pvc.ref.namespace, claim: pvc.ref.name });
  });

  ctx.route("GET /api/backups/volumes/:uid/backups", async (req) => {
    const pvc = await pvcByUid(req.params.uid);
    const volumes = await readVolumes(k8s());
    const found = volumes === "absent" ? undefined : volumes.byClaim.get(`${pvc.ref.namespace}/${pvc.ref.name}`);
    return found ? restorePoints(k8s(), found.volume.metadata.name) : [];
  });

  ctx.route("POST /api/backups/restore/plan", async (req, res) => {
    if (!ctx.require(req, res, "write")) return undefined;
    return ctx.call(req, "POST /api/deploy/actions/plan", { body: await restoreRequest(req.body) });
  });

  ctx.route("POST /api/backups/restore", async (req, res) => {
    if (!ctx.require(req, res, "write")) return undefined;
    return runAction(req, await restoreRequest(req.body));
  });

  registerConsoleRoutes(ctx, { pvcs: () => service.pvcs(), runAction });

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

// The deploy action checks these again; here they answer 400 before a job.
const groupName = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/, "must be lowercase letters, digits and dashes, at most 40");
const cron = z
  .string()
  .trim()
  .regex(/^[0-9*,/-]+( [0-9*,/-]+){4}$/, "must be a five-field cron such as 0 3 * * *");
const scheduleSchema = z.object({
  group: groupName,
  snapshotCron: cron.optional(),
  snapshotRetain: z.number().int().min(1).max(250).optional(),
  backupCron: cron.optional(),
  backupRetain: z.number().int().min(1).max(250).optional(),
});

export const defaultRestoreClaim = (claim: string, now = new Date()) =>
  `${claim}-restored-${now.toISOString().slice(0, 10).replaceAll("-", "")}`.slice(0, 253).replace(/[-.]+$/, "");

const pvcBody = z.object({ groups: z.array(groupName).max(10) });
const targetBody = z.object({ connectorId: z.string().trim().min(1).max(100).nullable() });
const schedulesBody = z.object({
  schedules: z
    .array(scheduleSchema)
    .max(20)
    .refine((list) => new Set(list.map((s) => s.group)).size === list.length, "each group may appear once"),
});
const restoreBody = z.object({
  uid: z.string().min(1).max(100),
  backupId: z.string().min(1).max(253),
  mode: z.enum(["new-pvc", "in-place"]),
  newClaim: z.string().trim().min(1).max(253).optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

const mod: Module = {
  id: "backups",
  milestone: "A",
  migrations,
  register,
};

export default mod;

import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Response } from "express";
import type { BackupVolumesAction, DeployJobView, VolumeBackupView } from "../../../contracts/deploy.js";
import { RESOURCES, type KubeObject } from "../../../contracts/k8s.js";
import type { ModuleContext } from "../../../contracts/module.js";
import type { SecretStore } from "../../../contracts/platform.js";
import { HttpError } from "../../../runtime/http.js";
import { errorMessage } from "../../../runtime/log.js";
import type { ActionContext, ActionRecipe, ActionRendered } from "./index.js";
import {
  actionVolumes,
  appTarget,
  BACKUP_LABEL,
  blockedAction,
  inspectMigration,
  newRunId,
  type MigrateVolume,
} from "./migrate.js";

// A download of each volume before a conversion: a pod in the app's
// namespace mounts the claims read-only and streams `tar czf -` of one over
// HTTP to whoever presents its token. This product's own pod fetches from it
// and passes the stream to the browser, so the token never leaves the server.
// The pod stops after an hour, or when told it is done.

export const BACKUP_PORT = 8080;
export const BACKUP_SECONDS = 3600;
const MOUNT_ROOT = "/volumes";

export const newBackupToken = () => randomBytes(24).toString("hex");

export const backupJobName = (release: string, runId: string) =>
  `${release}-backup-${runId}`.slice(0, 63).replace(/-+$/, "");

// Streams one claim per request; the claim must be one of the mounted
// directories. Python's http.server, not a shell, so nothing in the path
// reaches a command line.
export const BACKUP_SERVER = `
import hmac, http.server, os, shutil, subprocess, threading
TOKEN = os.environ["TOKEN"]
ROOT = "${MOUNT_ROOT}"
CLAIMS = set(os.listdir(ROOT))

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parts = self.path.strip("/").split("/")
        if len(parts) != 2 or not hmac.compare_digest(parts[0], TOKEN):
            self.send_error(404)
            return
        if parts[1] == "done":
            self.send_response(200)
            self.end_headers()
            threading.Thread(target=self.server.shutdown).start()
            return
        name = parts[1][:-len(".tar.gz")] if parts[1].endswith(".tar.gz") else ""
        if name not in CLAIMS:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/gzip")
        self.end_headers()
        tar = subprocess.Popen(["tar", "czf", "-", "-C", os.path.join(ROOT, name), "."], stdout=subprocess.PIPE)
        try:
            shutil.copyfileobj(tar.stdout, self.wfile, 1 << 20)
        finally:
            tar.stdout.close()
            tar.wait()

    def log_message(self, fmt, *args):
        print("%s %s" % (self.command, self.path.split("/")[-1]), flush=True)

print("Serving %d volume(s)" % len(CLAIMS), flush=True)
http.server.ThreadingHTTPServer(("", ${BACKUP_PORT}), Handler).serve_forever()
`;

export interface BackupRenderInput {
  runId: string;
  release: string;
  namespace: string;
  volumes: readonly Pick<MigrateVolume, "claim">[];
  image: string;
  token: string;
  ownedLabels: Record<string, string>;
}

export function backupFiles(input: BackupRenderInput): Record<string, string> {
  const name = backupJobName(input.release, input.runId);
  const labels = { ...input.ownedLabels, [BACKUP_LABEL]: input.runId };
  const job: KubeObject = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace: input.namespace, labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: BACKUP_SECONDS,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          containers: [
            {
              name: "backup",
              image: input.image,
              command: ["python3", "-c", BACKUP_SERVER],
              env: [{ name: "TOKEN", valueFrom: { secretKeyRef: { name, key: "token" } } }],
              ports: [{ name: "http", containerPort: BACKUP_PORT }],
              readinessProbe: { tcpSocket: { port: BACKUP_PORT }, periodSeconds: 2 },
              // Root with only read-anything, so files of every owner go in.
              securityContext: {
                runAsUser: 0,
                runAsGroup: 0,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"], add: ["DAC_READ_SEARCH"] },
              },
              resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { memory: "256Mi" } },
              volumeMounts: input.volumes.map((v, n) => ({
                name: `v${n}`,
                mountPath: `${MOUNT_ROOT}/${v.claim}`,
                readOnly: true,
              })),
            },
          ],
          volumes: input.volumes.map((v, n) => ({
            name: `v${n}`,
            persistentVolumeClaim: { claimName: v.claim, readOnly: true },
          })),
        },
      },
    },
  };
  const secret: KubeObject = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name, namespace: input.namespace, labels },
    type: "Opaque",
    stringData: { token: input.token },
  };
  return {
    "backup.json": JSON.stringify({ namespace: input.namespace, job: name, runId: input.runId, label: BACKUP_LABEL }),
    "backup-job.json": JSON.stringify(job),
    "backup-secret.json": JSON.stringify(secret),
  };
}

// Replaces any earlier backup of the app, then waits for the new pod to
// serve. The token Secret is owned by the Job so it goes with it.
export const BACKUP_SCRIPT = `set -eu
P=/values/backup.json
NS=$(jq -r .namespace "$P")
JOB=$(jq -r .job "$P")
LABEL=$(jq -r .label "$P")
echo "+ Preparing the backup"
kubectl -n "$NS" delete job,secret -l "$LABEL" --ignore-not-found --wait=true
kubectl -n "$NS" create -f /values/backup-job.json
UID_=$(kubectl -n "$NS" get job "$JOB" -o jsonpath='{.metadata.uid}')
jq --arg uid "$UID_" --arg job "$JOB" \\
  '.metadata.ownerReferences = [{apiVersion: "batch/v1", kind: "Job", name: $job, uid: $uid}]' \\
  /values/backup-secret.json | kubectl create -f - >/dev/null
kubectl -n "$NS" wait --for=condition=ready pod -l "$LABEL=$(jq -r .runId "$P")" --timeout=5m
echo "Backup ready to download for the next hour."
`;

export interface BackupPod {
  ip?: string;
  phase?: string;
  ready: boolean;
}

export function backupPod(pods: KubeObject[]): BackupPod | undefined {
  const pod = pods.toSorted((a, b) =>
    (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? "")
  )[0];
  if (!pod) return undefined;
  const status = (pod.status ?? {}) as {
    podIP?: string;
    phase?: string;
    conditions?: Array<{ type?: string; status?: string }>;
  };
  return {
    ip: status.podIP,
    phase: status.phase,
    ready: status.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false,
  };
}

// --- what a running backup needs to be downloaded --------------------------

interface BackupRecord {
  appId: string;
  release: string;
  namespace: string;
  runId: string;
  token: string;
  claims: string[];
  expiresAt: string;
}

const SCOPE = "deploy:backup";

// Kept in this pod and, when SECRETS_KEY is set, sealed in the secret store
// so the other pod of a rollout can serve the download too.
class BackupKeeper {
  private readonly memory = new Map<string, BackupRecord>();
  private secrets: SecretStore | undefined;

  attach(secrets: SecretStore): void {
    this.secrets = secrets;
    this.memory.clear();
  }

  async remember(jobId: string, record: BackupRecord): Promise<void> {
    this.memory.set(jobId, record);
    await this.secrets?.put(SCOPE, jobId, JSON.stringify(record)).catch(() => undefined);
  }

  async get(jobId: string): Promise<BackupRecord | undefined> {
    const local = this.memory.get(jobId);
    if (local) return local;
    try {
      const stored = await this.secrets?.get(SCOPE, jobId);
      return stored ? (JSON.parse(stored) as BackupRecord) : undefined;
    } catch {
      return undefined;
    }
  }

  async forget(jobId: string): Promise<void> {
    this.memory.delete(jobId);
    await this.secrets?.delete(SCOPE, jobId).catch(() => undefined);
  }
}

export const backupKeeper = new BackupKeeper();

export const backupAction: ActionRecipe<BackupVolumesAction> = {
  kind: "backup-volumes",

  async render(request: BackupVolumesAction, ctx: ActionContext): Promise<ActionRendered> {
    const target = appTarget(request.appId, ctx);
    const title = `Back up ${ctx.catalog?.get(request.appId)?.name ?? request.appId}'s volumes`;
    if (typeof target === "string") {
      return blockedAction(
        "backup-volumes",
        title,
        { appId: request.appId, release: request.appId, namespace: "", version: "" },
        target
      );
    }
    const base = { appId: target.appId, release: target.release, namespace: target.namespace, version: target.version };
    if (!ctx.k8s) return blockedAction("backup-volumes", title, base, "The Kubernetes API is not available.");
    const runId = newRunId();
    const i = await inspectMigration({
      k8s: ctx.k8s,
      appId: target.appId,
      release: target.release,
      namespace: target.namespace,
      entry: target.entry,
      discovery: await ctx.discover(),
      chartVersion: target.version || undefined,
      runId,
    });
    const volumes = actionVolumes(i);
    // Whatever stops a conversion, a volume that was found can still be saved.
    if (i.volumes.length === 0) return blockedAction("backup-volumes", title, base, i.blockedBy!, volumes);
    if (!ctx.enabled) {
      return blockedAction(
        "backup-volumes",
        title,
        base,
        `Deploys are off.${ctx.enableHint ? ` Turn them on with: ${ctx.enableHint}` : ""}`,
        volumes
      );
    }
    const name = backupJobName(target.release, runId);
    const token = ctx.run ? newBackupToken() : "";
    const claims = i.volumes.map((v) => v.claim);
    return {
      ...base,
      plan: {
        kind: "backup-volumes",
        title,
        allowed: true,
        steps: [
          {
            label: `Start a pod in ${target.namespace} that serves each volume read-only for an hour`,
            commands: [
              `kubectl -n ${target.namespace} create -f backup-job.json`,
              `kubectl -n ${target.namespace} wait --for=condition=ready pod -l ${BACKUP_LABEL}=${runId}`,
            ],
          },
        ],
        changes: [],
        creates: [
          { kind: "Job", name, namespace: target.namespace },
          { kind: "Secret", name, namespace: target.namespace },
        ],
        warnings: [
          `${target.name} keeps running while the backup is read, so a file being written at that moment may be ` +
            "caught half-written; the conversion itself copies with the app stopped.",
        ],
        volumes,
      },
      steps: [],
      script: BACKUP_SCRIPT,
      files: ctx.run
        ? backupFiles({
            runId,
            release: target.release,
            namespace: target.namespace,
            volumes: i.volumes,
            image: ctx.image,
            token,
            ownedLabels: ctx.k8s.ownedLabels(),
          })
        : {},
      ...(ctx.run
        ? {
            secrets: [token],
            onStarted: (job: DeployJobView) =>
              backupKeeper.remember(job.id, {
                appId: target.appId,
                release: target.release,
                namespace: target.namespace,
                runId,
                token,
                claims,
                expiresAt: new Date(Date.parse(job.createdAt) + BACKUP_SECONDS * 1000).toISOString(),
              }),
          }
        : {}),
    };
  },
};

export interface BackupJobs {
  get(id: string): DeployJobView | undefined;
}

const isoDate = (iso: string) => iso.slice(0, 10);

async function servingPod(ctx: ModuleContext, record: BackupRecord): Promise<BackupPod | undefined> {
  if (!ctx.services.has("k8s")) return undefined;
  const pods = await ctx.services
    .get("k8s")
    .list(RESOURCES.pods, { namespace: record.namespace, labelSelector: `${BACKUP_LABEL}=${record.runId}` });
  return pods === "absent" ? undefined : backupPod(pods);
}

export async function backupView(ctx: ModuleContext, job: DeployJobView, now: number): Promise<VolumeBackupView> {
  if (job.action !== "backup-volumes") throw new HttpError(404, `${job.id} is not a volume backup.`);
  const record = await backupKeeper.get(job.id);
  const base = { id: job.id, appId: job.appId, namespace: job.namespace, files: [] };
  if (job.state === "failed" || job.state === "cancelled") {
    return { ...base, state: "failed", message: job.message ?? `The backup job was ${job.state}.` };
  }
  if (!record) return { ...base, state: "gone", message: "This pod no longer has what it needs to serve it." };
  if (job.state !== "succeeded") return { ...base, state: "preparing", expiresAt: record.expiresAt };
  const pod = await servingPod(ctx, record).catch(() => undefined);
  if (!pod?.ready || !pod.ip || Date.parse(record.expiresAt) <= now) {
    return { ...base, state: "gone", message: "The backup pod has stopped; start a new backup to download again." };
  }
  return {
    ...base,
    state: "ready",
    expiresAt: record.expiresAt,
    files: record.claims.map((claim) => ({
      claim,
      path: `api/deploy/actions/backups/${encodeURIComponent(job.id)}/files/${encodeURIComponent(claim)}`,
      filename: `${record.appId}-${claim}-${isoDate(new Date(now).toISOString())}.tar.gz`,
    })),
  };
}

export interface BackupRouteOptions {
  jobs: BackupJobs;
  now?: () => number;
  // The backup pod's HTTP, for tests.
  fetch?: typeof fetch;
}

export function registerBackupRoutes(ctx: ModuleContext, options: BackupRouteOptions): void {
  backupKeeper.attach(ctx.secrets);
  const now = options.now ?? Date.now;
  const get = options.fetch ?? fetch;
  const jobOf = (id: string) => {
    const job = options.jobs.get(id);
    if (!job) throw new HttpError(404, `No deploy job "${id}".`);
    return job;
  };

  ctx.route("GET /api/deploy/actions/backups/:id", (req) => backupView(ctx, jobOf(req.params.id), now()));

  ctx.route("GET /api/deploy/actions/backups/:id/files/:claim", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    const job = jobOf(req.params.id);
    const view = await backupView(ctx, job, now());
    if (view.state !== "ready") throw new HttpError(409, view.message ?? `The backup is ${view.state}.`);
    const file = view.files.find((f) => f.claim === req.params.claim);
    if (!file) throw new HttpError(404, `${req.params.claim} is not in this backup.`);
    const record = (await backupKeeper.get(job.id))!;
    const pod = (await servingPod(ctx, record))!;
    await stream(
      res,
      get,
      `http://${pod.ip}:${BACKUP_PORT}/${record.token}/${encodeURIComponent(file.claim)}.tar.gz`,
      file.filename
    );
    ctx.audit.record({
      actor: user.id,
      action: "deploy.download-backup",
      target: job.id,
      detail: `${job.appId} ${file.claim} from ${job.namespace}`,
    });
    return undefined;
  });

  ctx.route("POST /api/deploy/actions/backups/:id/done", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    const job = jobOf(req.params.id);
    const view = await backupView(ctx, job, now());
    const record = await backupKeeper.get(job.id);
    if (view.state === "ready" && record) {
      const pod = await servingPod(ctx, record);
      await get(`http://${pod!.ip}:${BACKUP_PORT}/${record.token}/done`).catch(() => undefined);
    }
    if (record) await backupKeeper.forget(job.id);
    return { ...view, state: view.state === "failed" ? "failed" : "gone", files: [] };
  });
}

async function stream(res: Response, get: typeof fetch, url: string, filename: string): Promise<void> {
  let upstream: globalThis.Response;
  try {
    upstream = await get(url);
  } catch (err) {
    throw new HttpError(502, `Could not reach the backup pod: ${errorMessage(err)}`);
  }
  if (!upstream.ok || !upstream.body) throw new HttpError(502, `The backup pod answered ${upstream.status}.`);
  res.status(200).set({
    "Content-Type": "application/gzip",
    "Content-Disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });
  try {
    await pipeline(Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream), res);
  } catch {
    // The browser went away or the pod stopped mid-stream: the download is
    // incomplete and the browser shows it as failed.
    res.destroy();
  }
}

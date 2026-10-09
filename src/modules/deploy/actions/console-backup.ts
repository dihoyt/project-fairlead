import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "better-sqlite3";
import type { StorageTargetService, StorageTargetView } from "../../../contracts/connectors.js";
import {
  CONSOLE_BACKUP_APP,
  type ConsoleBackupAction,
  type DeployActionStep,
  type DeployJobView,
} from "../../../contracts/deploy.js";
import { RESOURCES, type K8sApi, type KubeObject } from "../../../contracts/k8s.js";
import { product } from "../../../product.js";
import { errorMessage } from "../../../runtime/log.js";
import { VALUES_DIR } from "../apps.js";
import type { ActionContext, ActionRecipe, ActionRendered, ConsoleDatabase } from "./index.js";
import { readBackupTarget } from "./longhorn-objects.js";
import { blockedAction } from "./migrate.js";

// A copy of this console's database on a storage target. The console writes
// a consistent copy (VACUUM INTO, whole under WAL) into a folder on its own
// volume; a Job on the same node mounts that volume and the target, copies
// the file across under a timestamped name, keeps the newest `keep` and
// deletes the local copy. NFS is mounted by the kubelet; S3 and MinIO are
// spoken to with curl's SigV4 signing. SMB needs a privileged mount, which
// a Job here does not get.

const KIND = "console-backup";
const SNAPSHOT_DIR = `${product.ownerMarker.externalPrefix}console-backup`;
export const TARGET_DIR = `${product.ownerMarker.externalPrefix}console`;
// A copy left by a run that never started is removed by the next one.
const STALE_MS = 60 * 60_000;
const DEADLINE_SECONDS = 1800;

export const backupFileName = (release: string, at: Date) =>
  `${release}-${at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}.db`;

// "Copied <file> (<bytes> bytes) to <url>": the Job's last line, and so the
// job row's message.
export const COPIED = /^Copied (\S+\.db) \((\d+) bytes\) to /;

export function createConsoleDatabase(
  db: Database,
  config: { namespace(): string; release(): string; consoleBackupKeep(): number },
  env: NodeJS.ProcessEnv = process.env
): ConsoleDatabase | undefined {
  if (!db.name || db.name === ":memory:") return undefined;
  const root = dirname(db.name);
  return {
    ...(env.NODE_ENV === "production" && env.HOSTNAME
      ? { pod: { name: env.HOSTNAME, namespace: config.namespace() } }
      : {}),
    release: config.release(),
    keep: () => config.consoleBackupKeep(),
    snapshot(name) {
      const dir = join(root, SNAPSHOT_DIR);
      mkdirSync(dir, { recursive: true });
      for (const old of readdirSync(dir)) {
        const path = join(dir, old);
        if (Date.now() - statSync(path).mtimeMs > STALE_MS) rmSync(path, { force: true });
      }
      const path = join(dir, name);
      rmSync(path, { force: true });
      db.prepare("VACUUM INTO ?").run(path);
      return { path: `${SNAPSHOT_DIR}/${name}`, bytes: statSync(path).size };
    },
  };
}

interface PodObject extends KubeObject {
  spec?: {
    nodeName?: string;
    volumes?: Array<{ name: string; persistentVolumeClaim?: { claimName: string } }>;
    containers?: Array<{ volumeMounts?: Array<{ name: string; mountPath: string }> }>;
  };
}

// The claim the console's database directory is mounted from, and the node
// its pod runs on.
async function consoleVolume(
  k8s: K8sApi,
  pod: { name: string; namespace: string }
): Promise<{ claim: string; node: string } | string> {
  const self = await k8s.get<PodObject>(RESOURCES.pods, pod.name, pod.namespace);
  if (self === null || self === "absent") return `Can't find this console's pod ${pod.namespace}/${pod.name}.`;
  const mounted = self.spec?.containers?.[0]?.volumeMounts?.find((m) => m.mountPath === "/data")?.name ?? "data";
  const claim = self.spec?.volumes?.find((v) => v.name === mounted)?.persistentVolumeClaim?.claimName;
  if (!claim) return "This console keeps its data on no volume (emptyDir), so there is nothing lasting to back up.";
  if (!self.spec?.nodeName) return "This console's pod has no node yet.";
  return { claim, node: self.spec.nodeName };
}

const trimSlash = (url: string) => url.replace(/\/+$/, "").toLowerCase();

// The asked-for target, else the one Longhorn backs up to, else the only one.
export async function resolveTarget(
  targets: StorageTargetService,
  k8s: K8sApi,
  connectorId: string | undefined
): Promise<StorageTargetView | string> {
  if (connectorId) return (await targets.get(connectorId)) ?? `No storage target "${connectorId}".`;
  const all = await targets.list();
  if (all.length === 0) return "Add a storage target under Connectors first.";
  const longhorn = await readBackupTarget(k8s).catch(() => null);
  const url = longhorn && longhorn !== "absent" ? longhorn.spec?.backupTargetURL : undefined;
  const behindLonghorn = url ? all.find((t) => trimSlash(t.url) === trimSlash(url)) : undefined;
  if (behindLonghorn) return behindLonghorn;
  if (all.length === 1) return all[0]!;
  return "Pick a storage target: there are several and Longhorn's backup target is none of them.";
}

const NFS = /^nfs:\/\/([^/:]+):(\/[^?#]*)$/;
const S3 = /^s3:\/\/([^@/]+)@([^/]+)\/(.*)$/;

interface Destination {
  protocol: "nfs" | "s3";
  // Shown in the plan and the last line.
  url: string;
  files: Record<string, string>;
  pod: {
    volumes: Array<{ name: string } & Record<string, unknown>>;
    mounts: Array<{ name: string; mountPath: string }>;
  };
}

function nfsDestination(target: StorageTargetView): Destination | string {
  const m = NFS.exec(target.url);
  if (!m) return `${target.url} is not an NFS URL this action can mount.`;
  const [, server, path] = m as unknown as [string, string, string];
  return {
    protocol: "nfs",
    url: `${target.url.replace(/\/?$/, "/")}${TARGET_DIR}/`,
    files: { protocol: "nfs" },
    pod: {
      volumes: [{ name: "target", nfs: { server, path: path.replace(/\/+$/, "") || "/" } }],
      mounts: [{ name: "target", mountPath: "/target" }],
    },
  };
}

function s3Destination(
  target: StorageTargetView,
  credentials: Record<string, string> | undefined
): Destination | string {
  const m = S3.exec(target.url);
  if (!m) return `${target.url} is not an S3 URL this action understands.`;
  const [, bucket, region, path] = m as unknown as [string, string, string, string];
  const accessKey = credentials?.AWS_ACCESS_KEY_ID;
  const secretKey = credentials?.AWS_SECRET_ACCESS_KEY;
  if (!accessKey || !secretKey) return `${target.name} has no stored access key.`;
  const endpoint = (target.endpoint || `https://s3.${region}.amazonaws.com`).replace(/\/+$/, "");
  const prefix = `${path.replace(/^\/+/, "").replace(/\/?$/, path ? "/" : "")}${TARGET_DIR}/`;
  return {
    protocol: "s3",
    url: `${target.url.replace(/\/?$/, "/")}${TARGET_DIR}/`,
    files: {
      protocol: "s3",
      endpoint,
      bucket,
      region,
      prefix,
      "access-key": accessKey,
      "secret-key": secretKey,
    },
    pod: { volumes: [], mounts: [] },
  };
}

export const consoleBackupAction: ActionRecipe<ConsoleBackupAction> = {
  kind: KIND,

  async render(request, ctx: ActionContext): Promise<ActionRendered> {
    const db = ctx.consoleDatabase;
    const release = db?.release ?? product.chartName;
    const base = {
      appId: CONSOLE_BACKUP_APP,
      release: CONSOLE_BACKUP_APP,
      namespace: db?.pod?.namespace ?? "",
      version: "",
    };
    let title = "Back up this console's database";
    if (!ctx.k8s) return blockedAction(KIND, title, base, "The Kubernetes API is not available.");
    if (!ctx.enabled) {
      return blockedAction(
        KIND,
        title,
        base,
        `Deploys are off.${ctx.enableHint ? ` Turn them on with: ${ctx.enableHint}` : ""}`
      );
    }
    if (!db?.pod) return blockedAction(KIND, title, base, "Only a console running in the cluster can back itself up.");
    if (!ctx.storageTargets) return blockedAction(KIND, title, base, "Storage targets are not available.");

    const target = await resolveTarget(ctx.storageTargets, ctx.k8s, request.connectorId);
    if (typeof target === "string") return blockedAction(KIND, title, base, target);
    title = `Back up this console's database to ${target.name}`;
    if (target.protocol === "smb") {
      return blockedAction(
        KIND,
        title,
        base,
        "SMB shares can't be mounted by a Job here. Pick an NFS or S3 target for the console's copy."
      );
    }
    const volume = await consoleVolume(ctx.k8s, db.pod);
    if (typeof volume === "string") return blockedAction(KIND, title, base, volume);

    let credentials: Record<string, string> | undefined;
    if (target.protocol === "s3") {
      try {
        credentials = (await ctx.storageTargets.credentialsSecret(target.id, db.pod.namespace))?.stringData;
      } catch (err) {
        return blockedAction(KIND, title, base, errorMessage(err));
      }
    }
    const destination = target.protocol === "nfs" ? nfsDestination(target) : s3Destination(target, credentials);
    if (typeof destination === "string") return blockedAction(KIND, title, base, destination);

    const keep = request.keep ?? db.keep();
    const name = backupFileName(release, new Date());
    const files: Record<string, string> = {
      ...destination.files,
      name,
      keep: String(keep),
      release,
      url: destination.url,
    };
    if (ctx.run) files.snapshot = db.snapshot(`${name}`).path;

    const steps: DeployActionStep[] = [
      {
        label: "Write a consistent copy of the database beside it (VACUUM INTO)",
        commands: [`VACUUM INTO '/data/${SNAPSHOT_DIR}/${name}'`],
      },
      {
        label: `Copy it to ${destination.url}${name}`,
        commands:
          destination.protocol === "nfs"
            ? [`cp /console/${SNAPSHOT_DIR}/${name} /target/${TARGET_DIR}/${name}`]
            : [`curl --aws-sigv4 aws:amz:<region>:s3 -T ${name} <endpoint>/<bucket>/<prefix>${name}`],
      },
      { label: `Keep the newest ${keep} copies and delete the local one`, commands: [] },
    ];
    const warnings: string[] = [];
    if (target.status === "crit") warnings.push(`${target.name}'s own reachability check is failing.`);

    return {
      ...base,
      plan: {
        kind: KIND,
        title,
        allowed: true,
        steps,
        changes: [],
        creates: [],
        warnings,
      },
      steps: [],
      script: CONSOLE_BACKUP_SCRIPT,
      files,
      secrets: credentials ? Object.values(credentials).filter((v) => v.length >= 4) : [],
      deadlineSeconds: DEADLINE_SECONDS,
      pod: {
        nodeName: volume.node,
        runAs: { user: process.getuid?.() ?? 10001, group: process.getgid?.() ?? 10001 },
        volumes: [{ name: "console", persistentVolumeClaim: { claimName: volume.claim } }, ...destination.pod.volumes],
        mounts: [{ name: "console", mountPath: "/console" }, ...destination.pod.mounts],
      },
    };
  },
};

// Keeps the newest $KEEP names matching this release's pattern, given one
// name per line on stdin; prints the rest.
const PRUNE = `sort -r | awk -v keep="$KEEP" 'NR > keep'`;

export const CONSOLE_BACKUP_SCRIPT = `set -eu
V=${VALUES_DIR}
val() { cat "$V/$1"; }
NAME=$(val name)
KEEP=$(val keep)
RELEASE=$(val release)
URL=$(val url)
SRC="/console/$(val snapshot)"
trap 'rm -f "$SRC"' EXIT
[ -s "$SRC" ] || { echo "The database copy $SRC is missing or empty."; exit 1; }
SIZE=$(wc -c < "$SRC" | tr -d ' ')
PATTERN="^$RELEASE-[0-9]{8}T[0-9]{6}Z\\.db$"
case "$(val protocol)" in
nfs)
  DIR="/target/${TARGET_DIR}"
  mkdir -p "$DIR"
  cp "$SRC" "$DIR/.$NAME.part"
  mv "$DIR/.$NAME.part" "$DIR/$NAME"
  ls -1 "$DIR" | grep -E "$PATTERN" | ${PRUNE} | while read -r old; do
    rm -f "$DIR/$old" && echo "Deleted $old"
  done
  ;;
s3)
  BASE="$(val endpoint)/$(val bucket)"
  PREFIX=$(val prefix)
  SIGN="aws:amz:$(val region):s3"
  USER_ARG="$(val access-key):$(val secret-key)"
  s3() { curl -fsS --aws-sigv4 "$SIGN" --user "$USER_ARG" "$@"; }
  s3 -T "$SRC" "$BASE/$PREFIX$NAME" > /dev/null
  s3 "$BASE?list-type=2&prefix=$PREFIX" | tr '<' '\\n' | sed -n 's#^Key>##p' | sed "s#^$PREFIX##" \\
    | grep -E "$PATTERN" | ${PRUNE} | while read -r old; do
    s3 -X DELETE "$BASE/$PREFIX$old" > /dev/null && echo "Deleted $old"
  done
  ;;
*) echo "Unknown protocol"; exit 1 ;;
esac
echo "Copied $NAME ($SIZE bytes) to $URL"
`;

// The newest succeeded copy, from the job rows.
export function lastGood(jobs: readonly DeployJobView[]): { at: string; file: string; sizeBytes?: number } | undefined {
  for (const job of jobs) {
    if (job.action !== KIND || job.state !== "succeeded") continue;
    const m = COPIED.exec(job.message ?? "");
    if (m) return { at: job.finishedAt ?? job.createdAt, file: m[1]!, sizeBytes: Number(m[2]) };
  }
  return undefined;
}

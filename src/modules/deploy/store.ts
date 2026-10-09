import type { Database } from "better-sqlite3";
import type {
  DeployActionKind,
  DeployedRelease,
  DeployJobMode,
  DeployJobState,
  DeployJobView,
} from "../../contracts/deploy.js";
import type { LogLines } from "../../contracts/workloads.js";

interface Row {
  seq: number;
  id: string;
  app_id: string;
  release: string;
  namespace: string;
  version: string;
  mode: DeployJobMode;
  action: DeployActionKind | null;
  state: DeployJobState;
  started_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  message: string | null;
  url: string | null;
  job_namespace: string;
  job_name: string;
  has_secrets: number;
  log: string | null;
  log_redacted: number;
  log_truncated: number;
}

export const FINAL: readonly DeployJobState[] = ["succeeded", "failed", "cancelled"];
export const isFinal = (state: DeployJobState) => FINAL.includes(state);

export interface JobRecord {
  view: DeployJobView;
  hasSecrets: boolean;
  log?: LogLines;
}

export interface NewJob {
  appId: string;
  release: string;
  namespace: string;
  version: string;
  mode: DeployJobMode;
  action?: DeployActionKind;
  startedBy: string;
  url?: string;
  jobNamespace: string;
  hasSecrets: boolean;
  jobName(seq: number): string;
}

function toRecord(row: Row): JobRecord {
  const view: DeployJobView = {
    id: row.id,
    appId: row.app_id,
    release: row.release,
    namespace: row.namespace,
    version: row.version,
    mode: row.mode,
    ...(row.action ? { action: row.action } : {}),
    state: row.state,
    startedBy: row.started_by,
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(row.message ? { message: row.message } : {}),
    ...(row.url ? { url: row.url } : {}),
    job: { namespace: row.job_namespace, name: row.job_name },
  };
  return {
    view,
    hasSecrets: row.has_secrets === 1,
    ...(row.log !== null
      ? {
          log: {
            lines: JSON.parse(row.log) as string[],
            redacted: row.log_redacted,
            truncated: row.log_truncated === 1,
          },
        }
      : {}),
  };
}

export class Store {
  private readonly db: Database;
  private readonly orgId: string;

  constructor(db: Database, orgId: string) {
    this.db = db;
    this.orgId = orgId;
  }

  nextSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS seq FROM deploy_jobs").get() as { seq: number | null };
    return (row.seq ?? 0) + 1;
  }

  // Inserts unless a job for the release is still going; the check and the
  // insert share one write transaction, so two pods can't both pass it.
  insert(job: NewJob, now: string): { created: JobRecord } | { busy: JobRecord } {
    const tx = this.db.transaction(() => {
      const running = this.db
        .prepare(
          `SELECT * FROM deploy_jobs WHERE org_id = ? AND release = ? AND state IN ('pending', 'running')
           ORDER BY seq DESC LIMIT 1`
        )
        .get(this.orgId, job.release) as Row | undefined;
      if (running) return { busy: toRecord(running) };
      const seq = this.nextSeq();
      const id = `dj_${seq}`;
      this.db
        .prepare(
          `INSERT INTO deploy_jobs (seq, id, org_id, app_id, release, namespace, version, mode, action, state,
             started_by, created_at, url, job_namespace, job_name, has_secrets)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          seq,
          id,
          this.orgId,
          job.appId,
          job.release,
          job.namespace,
          job.version,
          job.mode,
          job.action ?? null,
          job.startedBy,
          now,
          job.url ?? null,
          job.jobNamespace,
          job.jobName(seq),
          job.hasSecrets ? 1 : 0
        );
      return { created: this.get(id)! };
    });
    return tx.immediate();
  }

  get(id: string): JobRecord | undefined {
    const row = this.db.prepare("SELECT * FROM deploy_jobs WHERE org_id = ? AND id = ?").get(this.orgId, id) as
      Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(options: { appId?: string; limit: number }): DeployJobView[] {
    const rows = (
      options.appId
        ? this.db
            .prepare("SELECT * FROM deploy_jobs WHERE org_id = ? AND app_id = ? ORDER BY seq DESC LIMIT ?")
            .all(this.orgId, options.appId, options.limit)
        : this.db
            .prepare("SELECT * FROM deploy_jobs WHERE org_id = ? ORDER BY seq DESC LIMIT ?")
            .all(this.orgId, options.limit)
    ) as Row[];
    return rows.map((row) => toRecord(row).view);
  }

  // The latest install or upgrade job per release.
  releases(): DeployedRelease[] {
    const rows = this.db
      .prepare(
        `SELECT app_id, release, namespace, id, state FROM deploy_jobs AS j
         WHERE org_id = ? AND mode IN ('install', 'upgrade') AND seq = (
           SELECT MAX(seq) FROM deploy_jobs
           WHERE org_id = j.org_id AND release = j.release AND mode IN ('install', 'upgrade')
         ) AND NOT EXISTS (
           SELECT 1 FROM deploy_jobs
           WHERE org_id = j.org_id AND release = j.release AND seq > j.seq
             AND action = 'remove-app' AND state = 'succeeded'
         )
         ORDER BY seq DESC`
      )
      .all(this.orgId) as Array<{
      app_id: string;
      release: string;
      namespace: string;
      id: string;
      state: DeployJobState;
    }>;
    return rows.map((row) => ({
      appId: row.app_id,
      release: row.release,
      namespace: row.namespace,
      jobId: row.id,
      state: row.state,
    }));
  }

  // Release -> the version of its latest succeeded install or upgrade job.
  installedVersions(): Map<string, string> {
    const rows = this.db
      .prepare(
        `SELECT release, version FROM deploy_jobs AS j
         WHERE org_id = ? AND seq = (
           SELECT MAX(seq) FROM deploy_jobs
           WHERE org_id = j.org_id AND release = j.release AND mode IN ('install', 'upgrade') AND state = 'succeeded'
         )`
      )
      .all(this.orgId) as Array<{ release: string; version: string }>;
    return new Map(rows.map((row) => [row.release, row.version]));
  }

  active(): JobRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM deploy_jobs WHERE org_id = ? AND state IN ('pending', 'running') ORDER BY seq")
      .all(this.orgId) as Row[];
    return rows.map(toRecord);
  }

  markRunning(id: string, startedAt: string): void {
    this.db
      .prepare(
        `UPDATE deploy_jobs SET state = 'running', started_at = COALESCE(started_at, ?)
         WHERE org_id = ? AND id = ? AND state = 'pending'`
      )
      .run(startedAt, this.orgId, id);
  }

  // True only for the caller that moved it out of pending/running, so the
  // event and the log capture happen once across pods.
  finish(id: string, state: DeployJobState, at: string, message: string | undefined): boolean {
    const result = this.db
      .prepare(
        `UPDATE deploy_jobs SET state = ?, finished_at = ?, message = COALESCE(?, message),
           started_at = COALESCE(started_at, ?)
         WHERE org_id = ? AND id = ? AND state IN ('pending', 'running')`
      )
      .run(state, at, message ?? null, state === "cancelled" ? null : at, this.orgId, id);
    return result.changes === 1;
  }

  setMessage(id: string, message: string): void {
    this.db.prepare("UPDATE deploy_jobs SET message = ? WHERE org_id = ? AND id = ?").run(message, this.orgId, id);
  }

  saveLog(id: string, log: LogLines): void {
    this.db
      .prepare("UPDATE deploy_jobs SET log = ?, log_redacted = ?, log_truncated = ? WHERE org_id = ? AND id = ?")
      .run(JSON.stringify(log.lines), log.redacted, log.truncated ? 1 : 0, this.orgId, id);
  }
}

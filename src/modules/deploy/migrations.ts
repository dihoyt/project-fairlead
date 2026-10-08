import type { Migration } from "../../contracts/runtime.js";

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "deploy jobs",
    up: `
      CREATE TABLE deploy_jobs (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id),
        app_id TEXT NOT NULL,
        release TEXT NOT NULL,
        namespace TEXT NOT NULL,
        version TEXT NOT NULL,
        mode TEXT NOT NULL,
        state TEXT NOT NULL,
        started_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        message TEXT,
        url TEXT,
        job_namespace TEXT NOT NULL,
        job_name TEXT NOT NULL,
        -- The job carried secret values, so its log needs redacting.
        has_secrets INTEGER NOT NULL DEFAULT 0,
        -- The last lines, redacted, kept once the job is over: the pod goes
        -- with the Job's TTL.
        log TEXT,
        log_redacted INTEGER NOT NULL DEFAULT 0,
        log_truncated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX deploy_jobs_release ON deploy_jobs (org_id, release, state);
    `,
  },
];

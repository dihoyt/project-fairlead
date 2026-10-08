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
  {
    version: 2,
    name: "deploy bundle runs",
    up: `
      CREATE TABLE deploy_bundle_runs (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id),
        bundle_id TEXT NOT NULL,
        state TEXT NOT NULL,
        started_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        finished_at TEXT,
        -- JSON: [{ appId, state, jobId?, message?, url?, claimedAt? }] in order.
        steps TEXT NOT NULL,
        -- JSON BundleRequest with every secret value removed; those are
        -- sealed in the secret store under scope "deploy".
        request TEXT NOT NULL,
        -- Bumped on every write: a pod only applies a change to the
        -- revision it read, so two pods never both start the next step.
        rev INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    version: 3,
    name: "deploy access",
    up: `
      CREATE TABLE deploy_access (
        org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id) PRIMARY KEY,
        mode TEXT NOT NULL,
        base_domain TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
];

export interface ModuleStatus {
  id: string;
  milestone: "A" | "B";
  registered: boolean;
  error?: string;
  // Highest applied migration version, 0 for none.
  schemaVersion: number;
}

export interface Healthz {
  status: "ok";
  version: string;
}

export interface Draining {
  status: "draining";
}

export type JobsView = JobStatus[];

export interface JobStatus {
  name: string;
  module: string;
  intervalMs: number;
  running: boolean;
  runs: number;
  failures: number;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastOk?: boolean;
  lastError?: string;
  // Updated on every tick of the scheduler's loop for this job, run or skip;
  // a stale heartbeat means the loop itself has stopped.
  heartbeatAt?: string;
  nextRunAt?: string;
}

import { describe, expect, it } from "vitest";
import type { WorkloadView } from "@contracts/workloads";
import { workloadStatus } from "../shared";

const job = (over: Partial<WorkloadView>): WorkloadView => ({
  namespace: "apps",
  name: "deploy-example-1",
  kind: "Job",
  ready: "0/1",
  desired: 1,
  available: 0,
  images: [],
  managedBy: null,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

describe("workloadStatus for Jobs", () => {
  it("reads a Job that gave up as failed, not running", () => {
    expect(workloadStatus(job({ finished: "failed" }))).toEqual({ status: "crit", label: "Failed" });
  });

  it("reads a Job still working as running", () => {
    expect(workloadStatus(job({}))).toEqual({ status: "warn", label: "Running" });
  });

  it("reads a completed Job as complete", () => {
    expect(workloadStatus(job({ finished: "complete", ready: "1/1", available: 1 }))).toEqual({
      status: "ok",
      label: "Complete",
    });
  });
});

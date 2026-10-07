import { describe, expect, it } from "vitest";
import { objectLabel, workloadRoute } from "../labels";

describe("workloadRoute", () => {
  it("links pods and workload controllers into the workload browser", () => {
    expect(workloadRoute({ kind: "Pod", namespace: "default", name: "web-1" })).toBe("/workloads/default/pods/web-1");
    expect(workloadRoute({ kind: "StatefulSet", namespace: "db", name: "pg" })).toBe("/workloads/db/StatefulSet/pg");
  });

  it("links a node to its node page", () => {
    expect(workloadRoute({ kind: "Node", name: "worker-1" })).toBe("/nodes/worker-1");
  });

  it("has no route for kinds nothing browses", () => {
    expect(workloadRoute({ kind: "PersistentVolumeClaim", namespace: "media", name: "library" })).toBeNull();
    expect(workloadRoute({ kind: "StorageClass", name: "longhorn" })).toBeNull();
    expect(workloadRoute(undefined)).toBeNull();
  });
});

describe("objectLabel", () => {
  it("leaves the namespace out for cluster-scoped objects", () => {
    expect(objectLabel({ kind: "Node", name: "worker-1" })).toBe("Node worker-1");
    expect(objectLabel({ kind: "Pod", namespace: "default", name: "web-1" })).toBe("Pod default/web-1");
  });
});

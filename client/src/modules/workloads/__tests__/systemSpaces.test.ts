import { describe, expect, it } from "vitest";
import { hiddenUnlessSystem, isSystemSpace } from "../SpacesPage";

describe("isSystemSpace", () => {
  it("hides Kubernetes, cattle and Rancher project namespaces", () => {
    for (const name of [
      "kube-system",
      "longhorn-system",
      "cattle-fleet-system",
      "c-abc12",
      "c-abc12-p-2d2fx",
      "p-6fz7c",
      "user-gjl56",
      "cluster-fleet-local-local-1a3d67d0a899",
      "fleet-default",
      "fleet-local",
      "local",
    ]) {
      expect(isSystemSpace(name), name).toBe(true);
    }
  });

  it("keeps people's own namespaces", () => {
    for (const name of [
      "beszel",
      "media",
      "code-server",
      "coder-console",
      "cert-manager",
      "default",
      "c-app",
      "p-roject",
      "users",
    ]) {
      expect(isSystemSpace(name), name).toBe(false);
    }
  });

  it("hides default only while nothing runs in it", () => {
    expect(hiddenUnlessSystem({ name: "default", workloads: 0, pods: 0 })).toBe(true);
    expect(hiddenUnlessSystem({ name: "default", workloads: 1, pods: 1 })).toBe(false);
    expect(hiddenUnlessSystem({ name: "kube-system", workloads: 5, pods: 5 })).toBe(true);
    expect(hiddenUnlessSystem({ name: "gitea", workloads: 0, pods: 0 })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { isSystemSpace } from "../SpacesPage";

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
});

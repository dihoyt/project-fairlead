import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { BackupPosture, PostureRow } from "@contracts/backups";
import type { Status } from "@contracts/health";
import { mockCatalogApps } from "@contracts/mocks/catalog";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { FindingsStep } from "../steps/FindingsStep";

function row(name: string, status: Status, isProtected = false): PostureRow {
  return {
    pvc: { namespace: "apps", name, uid: name },
    coverage: [],
    protected: isProtected,
    ageStatus: status,
    ageDetail: "",
    status,
  };
}

function renderStep(rows: PostureRow[], overrides: Parameters<typeof stubApi>[0] = {}) {
  const posture: BackupPosture = { rows, sources: [], generatedAt: "2026-10-07T00:00:00Z" };
  stubApi({ "GET /api/backups/posture": posture, ...overrides });
  renderWithApp(
    <FindingsStep onFinish={async () => {}} findings={{ unprotectedPvcs: 9, unhealthyNodes: 0, failingBackups: 0 }} />
  );
}

const unprotectedTile = async (summary: string) =>
  (await screen.findByText(summary)).closest("[data-status]")?.getAttribute("data-status");

describe("FindingsStep", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rates unprotected PVCs as the board does", async () => {
    renderStep([row("a", "crit"), row("b", "warn"), row("c", "ok", true)]);
    expect(await unprotectedTile("2 no backup covers")).toBe("crit");
  });

  it("does not count informational rows, and an NFS-only gap is a warning", async () => {
    renderStep([row("nfs", "warn"), row("own", "absent")]);
    expect(await unprotectedTile("1 no backup covers")).toBe("warn");
  });

  it("offers Longhorn backups to a target when Longhorn is installed", async () => {
    renderStep([row("a", "crit")]);
    expect(await screen.findByRole("button", { name: "Deploy Longhorn backups" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Deploy Velero/ })).toBeNull();
  });

  it("offers Velero when Longhorn is not installed", async () => {
    const apps = mockCatalogApps.map((app) =>
      app.id === "longhorn" ? { ...app, detected: { ...app.detected, state: "not-installed" as const, urls: [] } } : app
    );
    renderStep([row("a", "crit")], { "GET /api/catalog/apps": apps });
    expect(await screen.findByRole("button", { name: "Deploy Velero" })).toBeInTheDocument();
  });

  it("offers no backup app when every PVC is covered", async () => {
    renderStep([row("c", "ok", true)]);
    expect(await screen.findByText("Every PVC is covered")).toBeInTheDocument();
    expect(screen.queryByText("Back them up")).toBeNull();
  });
});

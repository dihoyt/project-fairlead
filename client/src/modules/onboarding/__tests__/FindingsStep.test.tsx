import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { BackupPosture, PostureRow } from "@contracts/backups";
import type { Status } from "@contracts/health";
import { apiMocks } from "../../../ui/mocks/api";
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

function renderStep(rows: PostureRow[]) {
  const posture: BackupPosture = { rows, sources: [], generatedAt: "2026-10-07T00:00:00Z" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string) => {
      const body = String(url).includes("api/backups/posture") ? posture : apiMocks["GET /api/k8s/capabilities"];
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    })
  );
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
});

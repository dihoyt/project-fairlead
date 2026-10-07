import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { apiMocks } from "../../../ui/mocks/api";
import { renderWithApp } from "../../../test-utils";
import { ClusterStep } from "../steps/ClusterStep";

describe("ClusterStep", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows an opt-in grant as off by default rather than denied", async () => {
    const report = apiMocks["GET /api/k8s/capabilities"];
    const secret = report.capabilities.find((c) => c.optIn && c.groupPresent && !c.allowed);
    expect(secret).toBeDefined();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(report), { status: 200, headers: { "Content-Type": "application/json" } })
      )
    );
    renderWithApp(<ClusterStep onFinish={async () => {}} />);
    const row = (await screen.findByText(secret!.label)).closest("tr")!;
    expect(within(row).getByText("off by default")).toBeInTheDocument();
    expect(within(row).queryByText("denied")).toBeNull();
    expect(screen.getByText(/1 off by default/)).toBeInTheDocument();
  });
});

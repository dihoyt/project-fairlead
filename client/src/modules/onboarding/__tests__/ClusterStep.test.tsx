import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { mockDiscovery } from "@contracts/mocks/catalog";
import { apiMocks } from "../../../ui/mocks/api";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { ClusterStep } from "../steps/ClusterStep";

describe("ClusterStep", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows an opt-in grant as off by default rather than denied", async () => {
    const report = apiMocks["GET /api/k8s/capabilities"];
    const secret = report.capabilities.find((c) => c.optIn && c.groupPresent && !c.allowed);
    expect(secret).toBeDefined();
    stubApi();
    renderWithApp(<ClusterStep onFinish={async () => {}} />);
    const row = (await screen.findByText(secret!.label)).closest("tr")!;
    expect(within(row).getByText("off by default")).toBeInTheDocument();
    expect(within(row).queryByText("denied")).toBeNull();
    expect(screen.getByText(/1 off by default/)).toBeInTheDocument();
  });

  it("shows the cluster basics and offers a deploy for the missing one", async () => {
    stubApi();
    renderWithApp(<ClusterStep onFinish={async () => {}} />);
    const metrics = (await screen.findByText(mockDiscovery.basics[3]!.detail)).closest("tr")!;
    expect(within(metrics).getByRole("button", { name: "Deploy metrics-server" })).toBeInTheDocument();
    // Two defaults is a choice to make, not something a deploy fixes.
    const storage = screen.getByText(mockDiscovery.basics[0]!.detail).closest("tr")!;
    expect(within(storage).queryByRole("button")).toBeNull();
    const ingress = screen.getByText(mockDiscovery.basics[1]!.detail).closest("tr")!;
    expect(within(ingress).queryByRole("button")).toBeNull();
  });

  it("offers nothing when every basic is in place", async () => {
    stubApi({
      "GET /api/catalog/discovery": {
        ...mockDiscovery,
        basics: mockDiscovery.basics.map((b) => ({ ...b, status: "ok", fixAppIds: [] })),
      },
    });
    renderWithApp(<ClusterStep onFinish={async () => {}} />);
    await screen.findByText("Cluster basics");
    expect(screen.queryByRole("button", { name: /^Deploy / })).toBeNull();
  });
});

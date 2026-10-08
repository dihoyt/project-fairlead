import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { mockCatalogApps, mockDiscovery, mockIngressHosts } from "@contracts/mocks/catalog";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { checkProposals, checkedHost } from "../proposals";
import { ChecksStep } from "../steps/ChecksStep";

describe("checkProposals", () => {
  it("proposes each Ingress host nobody checks, named after its app", () => {
    const proposals = checkProposals(
      mockIngressHosts,
      [{ kind: "http", target: "https://grafana.example.test/api/health" }],
      mockCatalogApps
    );
    expect(proposals).toEqual([
      { host: "longhorn.example.test", url: "https://longhorn.example.test", label: "Longhorn" },
      { host: "jellyfin.example.test", url: "http://jellyfin.example.test", label: "jellyfin" },
    ]);
  });

  it("counts a tcp check on the host as watched", () => {
    expect(checkedHost({ kind: "tcp", target: "Jellyfin.example.test:8096" })).toBe("jellyfin.example.test");
    expect(checkProposals(mockIngressHosts, [{ kind: "tcp", target: "jellyfin.example.test:443" }])).toHaveLength(2);
  });
});

describe("ChecksStep", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("proposes unchecked hosts pre-ticked and adds the ticked ones", async () => {
    const { calls } = stubApi();
    renderWithApp(<ChecksStep onFinish={async () => {}} />);
    const longhorn = await screen.findByLabelText("Longhorn · https://longhorn.example.test");
    const jellyfin = screen.getByLabelText("jellyfin · http://jellyfin.example.test");
    expect(longhorn).toBeChecked();
    expect(jellyfin).toBeChecked();
    // Grafana already has a check.
    expect(screen.queryByLabelText(/Grafana · /)).toBeNull();

    fireEvent.click(jellyfin);
    fireEvent.click(screen.getByRole("button", { name: "Add 1 check" }));
    await waitFor(() => expect(calls.filter((c) => c.key === "POST /api/checks/:id/run")).toHaveLength(1));
    expect(calls.filter((c) => c.key === "POST /api/checks").map((c) => c.body)).toEqual([
      { label: "Longhorn", kind: "http", target: "https://longhorn.example.test" },
    ]);
  });

  it("proposes nothing when the cluster has no Ingress hosts", async () => {
    stubApi({ "GET /api/catalog/discovery": { ...mockDiscovery, ingressHosts: [] } });
    renderWithApp(<ChecksStep onFinish={async () => {}} />);
    expect(await screen.findByText("Add one by hand")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Found in the cluster")).toBeNull());
  });
});

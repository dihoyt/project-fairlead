import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { mockCatalogApps } from "@contracts/mocks/catalog";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { linksFromDiscovery } from "../links";
import { LinksStep } from "../steps/LinksStep";

const nothingFound = mockCatalogApps.map((app) => ({
  ...app,
  detected: { ...app.detected, state: "not-installed" as const, urls: [] },
}));

describe("linksFromDiscovery", () => {
  it("takes the first URL of each installed tool", () => {
    expect(linksFromDiscovery(mockCatalogApps)).toEqual({
      grafanaUrl: "https://grafana.example.test",
      longhornUrl: "https://longhorn.example.test",
    });
  });

  it("finds nothing when no tool is installed", () => {
    expect(linksFromDiscovery(nothingFound)).toEqual({});
  });
});

describe("LinksStep", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fills empty fields from the cluster and offers a deploy for each missing tool", async () => {
    stubApi();
    renderWithApp(<LinksStep onFinish={async () => {}} />);
    expect(await screen.findByText(/Filled in from what is in the cluster: Longhorn, Grafana/)).toBeInTheDocument();
    expect(screen.getByLabelText("Grafana")).toHaveValue("https://grafana.example.test");
    expect(screen.getByLabelText("Longhorn UI")).toHaveValue("https://longhorn.example.test");

    const headlamp = screen.getByText("Headlamp", { selector: "[data-offer] p" }).closest("[data-offer]")!;
    expect(within(headlamp as HTMLElement).getByRole("button", { name: "Deploy Headlamp" })).toBeInTheDocument();
    const grafana = document.querySelector('[data-offer="grafana"]') as HTMLElement;
    expect(within(grafana).queryByRole("button")).toBeNull();
    expect(within(grafana).getByText("https://grafana.example.test")).toBeInTheDocument();
  });

  it("leaves the fields alone and offers every tool when nothing is found", async () => {
    stubApi({ "GET /api/catalog/apps": nothingFound });
    renderWithApp(<LinksStep onFinish={async () => {}} />);
    expect(await screen.findByRole("button", { name: "Deploy Grafana" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deploy Rancher" })).toBeInTheDocument();
    expect(screen.queryByText(/Filled in from/)).toBeNull();
    expect(screen.getByLabelText("Grafana")).toHaveValue("");
  });
});

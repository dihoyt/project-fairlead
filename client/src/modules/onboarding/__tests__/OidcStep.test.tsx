import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { mockCatalogApps } from "@contracts/mocks/catalog";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { OidcStep } from "../steps/OidcStep";

describe("OidcStep", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers to deploy Authentik and says local admin is fine", async () => {
    stubApi();
    renderWithApp(<OidcStep onFinish={async () => {}} />);
    expect(await screen.findByRole("button", { name: "Deploy Authentik" })).toBeInTheDocument();
    expect(screen.getByText(/Local admin is fine for a homelab/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
  });

  it("offers to wire up the installed Authentik instead of a deploy", async () => {
    const apps = mockCatalogApps.map((app) =>
      app.id === "authentik"
        ? {
            ...app,
            detected: { ...app.detected, state: "installed" as const, urls: ["https://auth.example.test"] },
          }
        : app
    );
    stubApi({ "GET /api/catalog/apps": apps });
    renderWithApp(<OidcStep onFinish={async () => {}} />);
    expect(await screen.findByRole("button", { name: "Wire up Authentik" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deploy Authentik" })).toBeNull();
  });
});

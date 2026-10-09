import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { IngressHost } from "@contracts/catalog";
import { mockCatalogApps, mockDiscovery } from "@contracts/mocks/catalog";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { PocketIdWire } from "../steps/PocketIdWire";
import { OidcStep } from "../steps/OidcStep";

const pocketId = mockCatalogApps.find((app) => app.id === "pocket-id")!;
const installed = { ...pocketId, detected: { ...pocketId.detected, state: "installed" as const, urls: [] } };
const host: IngressHost = {
  host: "id.example.test",
  url: "https://id.example.test",
  tls: true,
  namespace: "pocket-id",
  ingress: "pocket-id",
  service: "pocket-id",
  serviceUrl: "http://pocket-id.pocket-id.svc:80",
  appId: "pocket-id",
};

describe("PocketIdWire", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows what it creates, sends the key once with the admin group, and offers a test sign-in", async () => {
    const { calls } = stubApi();
    const onWired = vi.fn();
    renderWithApp(
      <PocketIdWire publicUrl="https://id.example.test" apiUrl="http://pocket-id.pocket-id.svc:80" onWired={onWired} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Wire up Pocket ID" }));
    expect(await screen.findByText(/an OIDC client named/)).toBeInTheDocument();
    const plan = calls.find((c) => c.key === "GET /api/admin/oidc/pocket-id")!;
    expect(plan.url.searchParams.get("apiUrl")).toBe("http://pocket-id.pocket-id.svc:80");

    const create = screen.getByRole("button", { name: "Create in Pocket ID" });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Pocket ID API key"), { target: { value: "pid-key" } });
    fireEvent.change(screen.getByLabelText("Admin group (optional)"), { target: { value: "admins" } });
    fireEvent.click(create);

    expect(await screen.findByText("Pocket ID is wired up")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Test sign-in" })).toHaveAttribute(
      "href",
      expect.stringMatching(/auth\/oidc\/start\?link=1$/)
    );
    expect(calls.find((c) => c.key === "POST /api/admin/oidc/pocket-id")!.body).toEqual({
      pocketIdUrl: "https://id.example.test",
      apiUrl: "http://pocket-id.pocket-id.svc:80",
      apiKey: "pid-key",
      keepKey: false,
      adminGroups: ["admins"],
    });
    expect(onWired).toHaveBeenCalledOnce();
  });

  it("says passkeys need https for a plain-http Pocket ID", async () => {
    stubApi();
    const onOpenAccess = vi.fn();
    renderWithApp(<PocketIdWire publicUrl="http://id.example.test" onWired={() => {}} onOpenAccess={onOpenAccess} />);
    fireEvent.click(screen.getByRole("button", { name: "Wire up Pocket ID" }));
    expect(await screen.findByText(/passkeys, which work only over https/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set up https on the Access step" }));
    expect(onOpenAccess).toHaveBeenCalledOnce();
  });

  it("appears in the Sign-in step once Pocket ID is installed", async () => {
    stubApi({
      "GET /api/catalog/apps": mockCatalogApps.map((app) => (app.id === "pocket-id" ? installed : app)),
      "GET /api/catalog/discovery": { ...mockDiscovery, ingressHosts: [host] },
    });
    renderWithApp(<OidcStep onFinish={async () => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Wire up Pocket ID" })).toBeInTheDocument());
  });
});

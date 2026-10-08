import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { IngressHost } from "@contracts/catalog";
import { mockCatalogApps, mockDiscovery } from "@contracts/mocks/catalog";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { AuthentikWire, authentikAddresses } from "../steps/AuthentikWire";
import { OidcStep } from "../steps/OidcStep";

const authentik = mockCatalogApps.find((app) => app.id === "authentik")!;
const installed = { ...authentik, detected: { ...authentik.detected, state: "installed" as const, urls: [] } };
const host = (url: string, tls: boolean): IngressHost => ({
  host: new URL(url).host,
  url,
  tls,
  namespace: "authentik",
  ingress: "authentik-server",
  service: "authentik-server",
  serviceUrl: "http://authentik-server.authentik.svc:80",
  appId: "authentik",
});

describe("AuthentikWire", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("takes the public address from the Ingress and the API from its Service", () => {
    expect(
      authentikAddresses(installed, [host("http://auth.example.test", false), host("https://auth.example.test", true)])
    ).toEqual({
      publicUrl: "https://auth.example.test",
      apiUrl: "http://authentik-server.authentik.svc:80",
    });
    expect(authentikAddresses(installed, [])).toBeNull();
  });

  it("shows what it creates, sends the token once, and offers a test sign-in", async () => {
    const { calls } = stubApi();
    const onWired = vi.fn();
    renderWithApp(
      <AuthentikWire
        publicUrl="https://auth.example.test"
        apiUrl="http://authentik-server.authentik.svc:80"
        onWired={onWired}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Wire up Authentik" }));
    expect(await screen.findByText(/an OAuth2\/OpenID provider and an application named/)).toBeInTheDocument();
    const plan = calls.find((c) => c.key === "GET /api/admin/oidc/authentik")!;
    expect(plan.url.searchParams.get("apiUrl")).toBe("http://authentik-server.authentik.svc:80");

    const create = screen.getByRole("button", { name: "Create in Authentik" });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Authentik API token"), { target: { value: "ak-token" } });
    fireEvent.click(create);

    expect(await screen.findByText("Authentik is wired up")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Test sign-in" })).toHaveAttribute(
      "href",
      expect.stringMatching(/auth\/oidc\/start\?link=1$/)
    );
    const sent = calls.find((c) => c.key === "POST /api/admin/oidc/authentik")!.body;
    expect(sent).toEqual({
      authentikUrl: "https://auth.example.test",
      apiUrl: "http://authentik-server.authentik.svc:80",
      token: "ak-token",
      keepToken: false,
      adminGroups: ["authentik Admins"],
    });
    expect(onWired).toHaveBeenCalledOnce();
  });

  it("says sign-in needs https and links to the Access step for a plain-http Authentik", async () => {
    stubApi();
    const onOpenAccess = vi.fn();
    renderWithApp(
      <AuthentikWire publicUrl="http://auth.example.test" onWired={() => {}} onOpenAccess={onOpenAccess} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Wire up Authentik" }));
    expect(await screen.findByText(/Sign-in needs Authentik on https/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set up https on the Access step" }));
    expect(onOpenAccess).toHaveBeenCalledOnce();
  });

  it("appears in the Sign-in step once Authentik is installed", async () => {
    stubApi({
      "GET /api/catalog/apps": mockCatalogApps.map((app) => (app.id === "authentik" ? installed : app)),
      "GET /api/catalog/discovery": { ...mockDiscovery, ingressHosts: [host("https://auth.example.test", true)] },
    });
    renderWithApp(<OidcStep onFinish={async () => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Wire up Authentik" })).toBeInTheDocument());
  });
});

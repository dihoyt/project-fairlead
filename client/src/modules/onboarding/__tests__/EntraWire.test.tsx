import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { mockEntraSignIn } from "@contracts/mocks/connectors/views";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { EntraWire } from "../steps/EntraWire";
import { OidcStep } from "../steps/OidcStep";

const ready = { ...mockEntraSignIn, app: undefined, wired: false };

describe("EntraWire", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("points to the connector page when there is no Entra connector", async () => {
    stubApi({
      "GET /api/connector-entra/view": { redirectUri: "https://console.example.test/auth/oidc/callback", wired: false },
    });
    renderWithApp(<EntraWire onWired={() => {}} />);
    expect(await screen.findByRole("link", { name: "Add the Entra connector" })).toHaveAttribute(
      "href",
      expect.stringMatching(/\/admin\/connectors$/)
    );
  });

  it("explains an http public URL, links to the Access step and keeps setup off", async () => {
    stubApi({
      "GET /api/connector-entra/view": {
        ...ready,
        redirectUri: "http://10.0.0.5:32450/auth/oidc/callback",
        warning: "The public URL is http://10.0.0.5:32450, and Entra refuses http redirect URIs other than localhost.",
      },
    });
    const onOpenAccess = vi.fn();
    renderWithApp(<EntraWire onWired={() => {}} onOpenAccess={onOpenAccess} />);
    expect(await screen.findByText(/Entra refuses http redirect URIs/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up sign-in with Entra" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Set up https on the Access step" }));
    expect(onOpenAccess).toHaveBeenCalled();
  });

  it("creates the app with the chosen admin groups, then tests sign-in", async () => {
    const { calls } = stubApi({ "GET /api/connector-entra/view": ready });
    const onWired = vi.fn();
    renderWithApp(<EntraWire onWired={onWired} />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up sign-in with Entra" }));
    expect(screen.getByText(/https:\/\/console\.example\.test\/auth\/oidc\/callback/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "admin consent page" })).toHaveAttribute("href", ready.consentUrl);

    await waitFor(() => expect(calls.some((c) => c.key === "GET /api/connector-entra/groups")).toBe(true));
    const search = screen.getByPlaceholderText("Search groups");
    fireEvent.focus(search);
    fireEvent.click(search);
    fireEvent.click(await screen.findByText("Cluster admins"));
    fireEvent.click(screen.getByRole("button", { name: "Create in Entra" }));

    await waitFor(() => expect(onWired).toHaveBeenCalled());
    const post = calls.find((c) => c.key === "POST /api/connector-entra/signin")!;
    expect(post.body).toEqual({ adminGroups: ["44444444-0000-4000-8000-0000000000a1"] });
    expect(calls.some((c) => c.key === "POST /api/admin/oidc/test")).toBe(true);
    expect(onWired.mock.calls[0]![1]).toMatchObject({ ok: true });
  });

  it("falls back to typed group ids when groups can't be listed", async () => {
    stubApi({
      "GET /api/connector-entra/view": ready,
      "GET /api/connector-entra/groups": () => {
        throw Object.assign(new Error("Listing groups answered 403"), { status: 502 });
      },
    });
    renderWithApp(<EntraWire onWired={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up sign-in with Entra" }));
    expect(await screen.findByText(/Listing groups failed/)).toBeInTheDocument();
  });

  it("shows a wired app with its secret expiry and a test sign-in", async () => {
    stubApi();
    renderWithApp(<EntraWire onWired={() => {}} />);
    expect(await screen.findByText("Signing in through Microsoft Entra ID")).toBeInTheDocument();
    expect(screen.getByText(/its secret is valid until/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Test sign-in" })).toBeInTheDocument();
  });

  it("sits on the Sign-in step", async () => {
    stubApi({ "GET /api/connector-entra/view": ready });
    renderWithApp(<OidcStep onFinish={async () => {}} />);
    expect(await screen.findByRole("button", { name: "Set up sign-in with Entra" })).toBeInTheDocument();
  });
});

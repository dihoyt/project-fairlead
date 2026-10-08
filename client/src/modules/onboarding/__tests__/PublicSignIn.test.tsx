import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { PublicSignIn } from "../steps/PublicSignIn";

const none = { issuer: "", clientId: "", hasSecret: false, allowedEmails: [], adminEmails: [] };

describe("PublicSignIn", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the Microsoft steps and will not save without an allow list", async () => {
    stubApi();
    renderWithApp(
      <PublicSignIn redirectUri="https://console.example.test/auth/oidc/callback" current={none} onSaved={() => {}} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Microsoft" }));
    expect(
      screen.getByText(/Accounts in any organizational directory and personal Microsoft accounts/)
    ).toBeInTheDocument();
    expect(screen.getByText("https://console.example.test/auth/oidc/callback")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "ms-app" } });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "s3cret" } });
    expect(screen.getByRole("button", { name: "Save Microsoft sign-in" })).toBeDisabled();
  });

  it("saves Google with the allow and admin lists", async () => {
    const { calls } = stubApi();
    const onSaved = vi.fn();
    renderWithApp(
      <PublicSignIn redirectUri="https://console.example.test/auth/oidc/callback" current={none} onSaved={onSaved} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Google" }));
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "g-app" } });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "s3cret" } });
    fireEvent.change(screen.getByLabelText(/Who may sign in/), { target: { value: "ann@example.com\n@example.org" } });
    fireEvent.change(screen.getByLabelText("Admins"), { target: { value: "ann@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Google sign-in" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.find((c) => c.key === "POST /api/admin/oidc/public")!.body).toEqual({
      provider: "google",
      clientId: "g-app",
      clientSecret: "s3cret",
      allowedEmails: ["ann@example.com", "@example.org"],
      adminEmails: ["ann@example.com"],
    });
    expect(await screen.findByText("Google sign-in saved")).toBeInTheDocument();
  });

  it("warns about an http console address and links to the Access step", () => {
    stubApi();
    const onOpenAccess = vi.fn();
    renderWithApp(
      <PublicSignIn
        redirectUri="http://10.0.0.5:32450/auth/oidc/callback"
        current={none}
        onSaved={() => {}}
        onOpenAccess={onOpenAccess}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Google" }));
    fireEvent.click(screen.getByRole("button", { name: "Set up https on the Access step" }));
    expect(onOpenAccess).toHaveBeenCalled();
  });
});

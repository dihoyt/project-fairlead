import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithApp } from "../../../test-utils";
import { OidcProviderGuide } from "../OidcProviderGuide";

const REDIRECT = "https://console.example.com/auth/oidc/callback";

describe("OidcProviderGuide", () => {
  it("shows Entra ID first, with the redirect URI and its issuer pattern", () => {
    renderWithApp(<OidcProviderGuide redirectUri={REDIRECT} />);
    expect(screen.getByText("App registrations")).toBeInTheDocument();
    expect(screen.getByText(REDIRECT)).toBeInTheDocument();
    expect(screen.getByText("https://login.microsoftonline.com/<tenant-id>/v2.0")).toBeInTheDocument();
  });

  it.each([
    ["Authentik", "https://authentik.example.com/application/o/<app-slug>/"],
    ["Keycloak", "https://keycloak.example.com/realms/<realm>"],
    ["Google", "https://accounts.google.com"],
  ])("switches to %s", (name, issuer) => {
    renderWithApp(<OidcProviderGuide redirectUri={REDIRECT} />);
    fireEvent.click(screen.getByText(name));
    expect(screen.getByText(issuer)).toBeInTheDocument();
    expect(screen.getByText(REDIRECT)).toBeInTheDocument();
  });

  it("names the redirect URI without one configured", () => {
    renderWithApp(<OidcProviderGuide redirectUri="" />);
    expect(screen.getByText("the redirect URI")).toBeInTheDocument();
  });
});

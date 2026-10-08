import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { RemoteAccess } from "../steps/RemoteAccess";

describe("RemoteAccess", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers a tunnel and a tailnet", async () => {
    stubApi();
    renderWithApp(<RemoteAccess />);
    expect(await screen.findByRole("button", { name: "Deploy Cloudflare Tunnel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deploy Tailscale" })).toBeInTheDocument();
  });

  it("shows nothing when the catalog cannot be read", async () => {
    stubApi({
      "GET /api/catalog/apps": () => {
        throw Object.assign(new Error("catalog down"), { status: 500 });
      },
    });
    const { container } = renderWithApp(<RemoteAccess />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector("[data-remote-access]")).toBeNull();
  });
});

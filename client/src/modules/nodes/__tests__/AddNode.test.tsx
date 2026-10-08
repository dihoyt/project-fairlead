import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { apiMocks } from "../../../ui/mocks/api";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { AddNode } from "../AddNode";

describe("AddNode", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("makes a join link and shows the one-liner with its expiry", async () => {
    const { calls } = stubApi();
    renderWithApp(<AddNode canCreate />);
    fireEvent.click(await screen.findByRole("button", { name: "Make a join link" }));
    expect(await screen.findByText(apiMocks["POST /api/cluster/join-links"].command)).toBeInTheDocument();
    expect(screen.getByText(/Works once, until/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy command" })).toBeInTheDocument();
    const post = calls.find((c) => c.key === "POST /api/cluster/join-links");
    expect(post?.body).toMatchObject({ role: "agent" });
    expect((post?.body as { baseUrl?: string } | undefined)?.baseUrl).toMatch(/^http/);
  });

  it("explains why when joining is off, and offers no button", async () => {
    stubApi({
      "GET /api/cluster/join": {
        state: "off",
        reason: "No Secret k3s-join in namespace apps.",
        roles: [],
        links: [],
      },
    });
    renderWithApp(<AddNode canCreate />);
    expect(await screen.findByText(/No Secret k3s-join/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make a join link" })).toBeNull();
  });

  it("offers the control-plane role only when the cluster can take one", async () => {
    stubApi({ "GET /api/cluster/join": { ...apiMocks["GET /api/cluster/join"], roles: ["agent", "server"] } });
    renderWithApp(<AddNode canCreate />);
    expect(await screen.findByText("Control plane")).toBeInTheDocument();
  });

  it("leaves the link to admins", async () => {
    stubApi();
    renderWithApp(<AddNode canCreate={false} />);
    expect(await screen.findByText("An admin can make the link.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make a join link" })).toBeNull();
  });
});

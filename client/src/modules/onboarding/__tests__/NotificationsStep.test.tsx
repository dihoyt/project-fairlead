import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockCatalogApps } from "@contracts/mocks/catalog";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { NotificationsStep } from "../steps/NotificationsStep";

describe("NotificationsStep", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts on the public ntfy server and offers to deploy one when self-hosted is picked", async () => {
    stubApi();
    renderWithApp(<NotificationsStep onFinish={async () => {}} />);
    expect(await screen.findByLabelText("Server")).toHaveValue("https://ntfy.sh");
    expect(screen.queryByRole("button", { name: "Deploy ntfy" })).toBeNull();
    await userEvent.setup().click(screen.getByText("Self-hosted ntfy"));
    expect(await screen.findByRole("button", { name: "Deploy ntfy" })).toBeInTheDocument();
    expect(screen.getByLabelText("Server")).toHaveValue("");
  });

  it("uses the cluster's own ntfy server when one is found", async () => {
    const apps = mockCatalogApps.map((app) =>
      app.id === "ntfy"
        ? { ...app, detected: { ...app.detected, state: "installed" as const, urls: ["https://ntfy.example.test/"] } }
        : app
    );
    stubApi({ "GET /api/catalog/apps": apps });
    renderWithApp(<NotificationsStep onFinish={async () => {}} />);
    await waitFor(() => expect(screen.getByLabelText("Server")).toHaveValue("https://ntfy.example.test"));
    expect(screen.queryByRole("button", { name: "Deploy ntfy" })).toBeNull();
  });
});

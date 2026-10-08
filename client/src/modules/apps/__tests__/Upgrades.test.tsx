import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { mockUpgradeReport } from "@contracts/mocks/catalog";
import { renderWithApp } from "../../../test-utils";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { UpgradesSection, upgradeAll } from "../Upgrades";

const names = { gitea: "Gitea", ntfy: "ntfy", longhorn: "Longhorn" };

const row = (appId: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-upgrade="${appId}"]`);
    expect(el).not.toBeNull();
    return el!;
  });

describe("UpgradesSection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("upgrades all only what is available, never an unknown version", () => {
    expect(upgradeAll(mockUpgradeReport).map((app) => app.appId)).toEqual(["gitea"]);
  });

  it("offers Upgrade per app only where one can run", async () => {
    stubApi();
    renderWithApp(<UpgradesSection names={names} onFinished={() => {}} />);
    const gitea = await row("gitea");
    expect(within(gitea).getByText("upgrade available")).toBeInTheDocument();
    expect(within(gitea).getByRole("button", { name: "Upgrade" })).toBeInTheDocument();
    expect(within(await row("ntfy")).getByRole("button", { name: "Upgrade" })).toBeInTheDocument();
    expect(within(await row("longhorn")).queryByRole("button", { name: "Upgrade" })).toBeNull();
    expect(within(await row("longhorn")).getByText(/newest this cluster can run/)).toBeInTheDocument();
    expect(within(await row("metrics-server")).queryByRole("button", { name: "Upgrade" })).toBeNull();
  });

  it("previews from/to with notes, then starts the run and shows its progress", async () => {
    const { calls } = stubApi();
    renderWithApp(<UpgradesSection names={names} onFinished={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Upgrade all (1)" }));
    const preview = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-upgrade-preview="gitea"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(within(preview).getByText("0.0.0-alpha → 0.0.0-mock")).toBeInTheDocument();
    expect(within(preview).getByText(/back up first/)).toBeInTheDocument();
    expect(within(preview).getByText(/--reset-then-reuse-values/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Upgrade" }));
    await waitFor(() => expect(calls.some((c) => c.key === "POST /api/deploy/upgrades")).toBe(true));
    expect(calls.find((c) => c.key === "POST /api/deploy/upgrades")?.body).toEqual({ appIds: ["gitea"] });
    await waitFor(() => expect(calls.some((c) => c.key === "GET /api/deploy/bundles/:id")).toBe(true));
  });

  it("disables upgrades when deploys are off", async () => {
    stubApi({ "GET /api/deploy/upgrades": { ...mockUpgradeReport, enabled: false } });
    renderWithApp(<UpgradesSection names={names} onFinished={() => {}} />);
    expect(await screen.findByRole("button", { name: "Upgrade all (1)" })).toBeDisabled();
  });
});

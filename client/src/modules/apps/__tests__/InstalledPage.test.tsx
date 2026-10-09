import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { mockCatalogApps, mockFailedJob, mockGateStatus, mockUpgradeReport } from "@contracts/mocks/catalog";
import {
  mockPortsView,
  mockTemplatesView,
  mockTemplateRemoveJob,
  mockTemplateRemovePlan,
} from "@contracts/mocks/templates";
import { renderWithApp } from "../../../test-utils";
import { stubApi, stubEventSource } from "../../../ui/deploy/__tests__/stubApi";
import { InstalledPage, installedRows } from "../InstalledPage";
import { upgradeAll } from "../Upgrades";

const row = (id: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-installed="${id}"]`);
    expect(el).not.toBeNull();
    return el!;
  });

describe("installedRows", () => {
  it("lists discovered apps, template instances, external services and runner-only apps once each", () => {
    const rows = installedRows(
      mockCatalogApps,
      mockTemplatesView.instances,
      mockUpgradeReport,
      mockGateStatus.apps,
      mockPortsView
    );
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["longhorn", "grafana", "my-api", "status", "whoami", "valheim", "nas", "gitea", "ntfy"]) {
      expect(ids).toContain(id);
    }
    const valheim = rows.find((r) => r.id === "valheim")!;
    expect(valheim.source).toBe("External UDP 10.0.0.50:2456");
    expect(valheim.direct).toBe("10.0.0.10:25565");
    expect(rows.find((r) => r.id === "status")!.storage).toBe("1Gi on longhorn");
    expect(rows.find((r) => r.id === "gitea")!.gate?.state).toBe("gated");
  });
});

describe("InstalledPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("upgrades all only what is available, never an unknown version", () => {
    expect(upgradeAll(mockUpgradeReport).map((app) => app.appId)).toEqual(["gitea"]);
  });

  it("is a table with per-row actions where they apply", async () => {
    stubApi();
    renderWithApp(<InstalledPage />);
    const gitea = await row("gitea");
    expect(within(gitea).getByText("upgrade available")).toBeInTheDocument();
    expect(within(gitea).getByRole("button", { name: "Upgrade" })).toBeInTheDocument();
    expect(within(gitea).getByRole("switch", { name: "Gitea is public" })).not.toBeChecked();
    expect(within(await row("ntfy")).getByRole("button", { name: "Upgrade" })).toBeInTheDocument();
    expect(within(await row("longhorn")).queryByRole("button", { name: "Upgrade" })).toBeNull();
    expect(within(await row("status")).getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(within(await row("status")).getByRole("button", { name: "Deploy again" })).toBeInTheDocument();
    const valheim = await row("valheim");
    expect(within(valheim).getByText("10.0.0.10:25565")).toBeInTheDocument();
    expect(within(valheim).getByText("direct")).toBeInTheDocument();
    expect(within(valheim).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(await row("my-api")).getByText("failed")).toBeInTheDocument();
    expect(within(await row("my-api")).getByText("inside the cluster only")).toBeInTheDocument();
    expect(await screen.findByTestId("forwarded-ports")).toHaveTextContent("UDP 25565 → valheim (not open yet)");
  });

  it("previews from/to with notes, then starts the run and shows its progress", async () => {
    const { calls } = stubApi();
    renderWithApp(<InstalledPage />);
    await row("gitea");
    fireEvent.click(await screen.findByRole("button", { name: "Upgrade all (1)" }));
    const preview = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-upgrade-preview="gitea"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(within(preview).getByText("0.0.0-alpha → 0.0.0-mock")).toBeInTheDocument();
    expect(within(preview).getByText(/back up first/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Upgrade" }));
    await waitFor(() => expect(calls.some((c) => c.key === "POST /api/deploy/upgrades")).toBe(true));
    expect(calls.find((c) => c.key === "POST /api/deploy/upgrades")?.body).toEqual({ appIds: ["gitea"] });
    await waitFor(() => expect(calls.some((c) => c.key === "GET /api/deploy/bundles/:id")).toBe(true));
  });

  it("disables upgrades when deploys are off", async () => {
    stubApi({ "GET /api/deploy/upgrades": { ...mockUpgradeReport, enabled: false } });
    renderWithApp(<InstalledPage />);
    expect(await screen.findByRole("button", { name: "Upgrade all (1)" })).toBeDisabled();
  });

  it("removes a template app, keeping its volume unless asked", async () => {
    const { calls } = stubApi({
      "POST /api/deploy/actions/plan": mockTemplateRemovePlan,
      "POST /api/deploy/actions/run": mockTemplateRemoveJob,
      "GET /api/deploy/jobs/:id": mockTemplateRemoveJob,
    });
    stubEventSource();
    renderWithApp(<InstalledPage />);
    fireEvent.click(within(await row("status")).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/its volume stay/)).toBeInTheDocument();
    expect(calls.find((c) => c.key === "POST /api/deploy/actions/plan")?.body).toEqual({
      kind: "remove-app",
      appId: "status",
      deleteVolumes: false,
    });
  });

  it("marks an app whose deploy failed and offers Retry, Reinstall and Uninstall", async () => {
    const failedGitea = {
      ...mockFailedJob,
      appId: "gitea",
      release: "gitea",
      namespace: "gitea",
      message: "Error: timed out",
    };
    const created = mockCatalogApps.map((app) =>
      app.id === "gitea" ? { ...app, detected: { ...app.detected, state: "installed" as const, ownedByUs: true } } : app
    );
    const { calls } = stubApi({ "GET /api/deploy/jobs": [failedGitea], "GET /api/catalog/apps": created });
    stubEventSource([]);
    renderWithApp(<InstalledPage />);
    const gitea = await waitFor(async () => {
      const el = await row("gitea");
      expect(within(el).getByText("install failed")).toBeInTheDocument();
      return el;
    });
    expect(within(gitea).queryByRole("button", { name: "Upgrade" })).toBeNull();
    expect(within(gitea).getByRole("button", { name: "Reinstall" })).toBeInTheDocument();
    expect(within(gitea).getByRole("button", { name: "Uninstall" })).toBeInTheDocument();
    fireEvent.click(within(gitea).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls.some((c) => c.key === "POST /api/deploy/jobs/:id/retry")).toBe(true));
    expect(calls.find((c) => c.key === "POST /api/deploy/jobs/:id/retry")!.url.pathname).toMatch(
      /\/jobs\/dj_3\/retry$/
    );
    expect(await screen.findByText("Retry Gitea")).toBeInTheDocument();
  });

  it("deploys again from the form when the failed attempt never created the release", async () => {
    const failedGitea = { ...mockFailedJob, appId: "gitea", release: "gitea", namespace: "gitea" };
    stubApi({ "GET /api/deploy/jobs": [failedGitea] });
    renderWithApp(<InstalledPage />);
    const gitea = await waitFor(async () => {
      const el = await row("gitea");
      within(el).getByText("install failed");
      return el;
    });
    expect(within(gitea).queryByRole("button", { name: "Retry" })).toBeNull();
    expect(within(gitea).getByRole("button", { name: "Deploy again" })).toBeInTheDocument();
  });

  it("asks whether to keep the volumes before it uninstalls", async () => {
    const failedGitea = { ...mockFailedJob, appId: "gitea", release: "gitea", namespace: "gitea" };
    const plan = {
      ...mockTemplateRemovePlan,
      title: "Uninstall Gitea",
      deletes: [{ kind: "HelmRelease", name: "gitea", namespace: "gitea" }],
    };
    const { calls } = stubApi({
      "GET /api/deploy/jobs": [failedGitea],
      "POST /api/deploy/actions/plan": plan,
      "POST /api/deploy/actions/run": mockTemplateRemoveJob,
    });
    stubEventSource([]);
    renderWithApp(<InstalledPage />);
    const gitea = await waitFor(async () => {
      const el = await row("gitea");
      within(el).getByText("install failed");
      return el;
    });
    fireEvent.click(within(gitea).getByRole("button", { name: "Uninstall" }));
    const go = await screen.findByRole("button", { name: "Uninstall Gitea" });
    expect(go).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "Delete the volumes and their data for good" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Uninstall Gitea" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Uninstall Gitea" }));
    await waitFor(() => expect(calls.some((c) => c.key === "POST /api/deploy/actions/run")).toBe(true));
    expect(calls.find((c) => c.key === "POST /api/deploy/actions/run")!.body).toEqual({
      kind: "remove-app",
      appId: "gitea",
      deleteVolumes: true,
    });
  });
});

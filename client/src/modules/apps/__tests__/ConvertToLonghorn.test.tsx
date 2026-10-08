import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { mockCatalogApps, mockMigrateJob, mockMigratePlan, mockVolumeBackup } from "@contracts/mocks/catalog";
import type { CatalogAppView } from "@contracts/catalog";
import { renderWithApp } from "../../../test-utils";
import { stubApi, stubEventSource } from "../../../ui/deploy/__tests__/stubApi";
import { InstalledPage } from "../InstalledPage";
import { ConvertDialog } from "../ConvertToLonghorn";

const backupJob = { ...mockMigrateJob, id: "dj_8", action: "backup-volumes" as const };

function runs(url: URL, body: unknown) {
  void url;
  return (body as { kind: string }).kind === "backup-volumes" ? backupJob : mockMigrateJob;
}

describe("Convert to Longhorn", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is offered on apps deployed from here that keep data", async () => {
    const apps: CatalogAppView[] = mockCatalogApps.map((app) =>
      app.id === "gitea"
        ? {
            ...app,
            detected: { ...app.detected, state: "installed", namespace: "gitea", ownedByUs: true, urls: [] },
          }
        : app
    );
    stubApi({ "GET /api/catalog/apps": apps });
    renderWithApp(<InstalledPage />);
    const gitea = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-installed="gitea"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(within(gitea).getByRole("button", { name: "Convert to Longhorn" })).toBeInTheDocument();
    const longhorn = document.querySelector<HTMLElement>('[data-installed="longhorn"]')!;
    expect(within(longhorn).queryByRole("button", { name: "Convert to Longhorn" })).toBeNull();
  });

  it("previews volumes and downtime, offers the backup download, then converts", async () => {
    const { calls } = stubApi({
      "POST /api/deploy/actions/plan": mockMigratePlan,
      "POST /api/deploy/actions/run": runs,
      "GET /api/deploy/jobs/:id": (url: URL) => (url.pathname.endsWith("dj_8") ? backupJob : mockMigrateJob),
    });
    stubEventSource();
    renderWithApp(<ConvertDialog appId="gitea" name="Gitea" onFinished={() => {}} />);

    const volumes = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-volumes]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(within(volumes).getByText("gitea/gitea-shared-storage")).toBeInTheDocument();
    expect(within(volumes).getByText("700 MiB")).toBeInTheDocument();
    expect(within(volumes).getByText("local-path on node-1")).toBeInTheDocument();
    expect(screen.getByText(/stopped for about 3 minutes/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Download a backup first/ })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Prepare the backup" }));
    const link = await screen.findByRole("link", { name: /gitea-gitea-shared-storage-2026-10-07\.tar\.gz/ });
    expect(link.getAttribute("href")).toMatch(/api\/deploy\/actions\/backups\/dj_8\/files\/gitea-shared-storage$/);
    expect(calls.find((c) => c.key === "POST /api/deploy/actions/run")?.body).toEqual({
      kind: "backup-volumes",
      appId: "gitea",
    });

    fireEvent.click(screen.getByRole("button", { name: "Continue: convert" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.key === "POST /api/deploy/actions/run").at(-1)?.body).toEqual({
        kind: "migrate-to-longhorn",
        appId: "gitea",
      })
    );
    await waitFor(() => expect(document.querySelector('[data-convert-phase="convert"]')).not.toBeNull());
  });

  it("converts straight away when the backup is left out", async () => {
    const { calls } = stubApi({
      "POST /api/deploy/actions/plan": mockMigratePlan,
      "POST /api/deploy/actions/run": runs,
    });
    stubEventSource();
    renderWithApp(<ConvertDialog appId="gitea" name="Gitea" onFinished={() => {}} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Download a backup first/ }));
    fireEvent.click(screen.getByRole("button", { name: "Convert Gitea to Longhorn" }));
    await waitFor(() =>
      expect(calls.find((c) => c.key === "POST /api/deploy/actions/run")?.body).toEqual({
        kind: "migrate-to-longhorn",
        appId: "gitea",
      })
    );
    expect(calls.some((c) => c.key === "GET /api/deploy/actions/backups/:id")).toBe(false);
  });

  it("shows why it can't convert and offers nothing to run", async () => {
    stubApi({
      "POST /api/deploy/actions/plan": {
        ...mockMigratePlan,
        allowed: false,
        blockedBy: "None of its volumes are on local-path (gitea-shared-storage (longhorn)).",
        steps: [],
        downtime: undefined,
      },
    });
    renderWithApp(<ConvertDialog appId="gitea" name="Gitea" onFinished={() => {}} />);
    expect(await screen.findByText(/None of its volumes are on local-path/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Download a backup first/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Prepare the backup" })).toBeDisabled();
  });

  it("says when the backup pod has stopped", async () => {
    stubApi({
      "POST /api/deploy/actions/plan": mockMigratePlan,
      "POST /api/deploy/actions/run": runs,
      "GET /api/deploy/actions/backups/:id": { ...mockVolumeBackup, state: "gone", files: [], message: "Stopped." },
    });
    stubEventSource();
    renderWithApp(<ConvertDialog appId="gitea" name="Gitea" onFinished={() => {}} />);
    await screen.findByText(/stopped for about 3 minutes/);
    fireEvent.click(screen.getByRole("button", { name: "Prepare the backup" }));
    expect(await screen.findByText(/Stopped\. Converting is still possible\./)).toBeInTheDocument();
  });
});

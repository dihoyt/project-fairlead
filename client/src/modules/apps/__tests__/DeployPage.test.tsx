import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { mockCatalogApps, mockDeployDisabled, mockFailedJob } from "@contracts/mocks/catalog";
import { renderWithApp } from "../../../test-utils";
import { stubApi, stubEventSource } from "../../../ui/deploy/__tests__/stubApi";
import { groupBySlot } from "../CatalogTab";
import { DeployPage } from "../DeployPage";

const card = (appId: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-app="${appId}"]`);
    expect(el).not.toBeNull();
    return el!;
  });

describe("DeployPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists each app once, under its first slot, in slot order", () => {
    const groups = groupBySlot(mockCatalogApps);
    expect(groups.map((g) => g.slot)).toEqual([
      "cluster-basics",
      "links",
      "backups",
      "sign-in",
      "notifications",
      "remote-access",
    ]);
    const ids = groups.flatMap((g) => g.apps.map((a) => a.id));
    expect(ids).toHaveLength(mockCatalogApps.length);
    expect(groups.find((g) => g.slot === "links")!.apps.map((a) => a.id)).toContain("longhorn");
    expect(groups.find((g) => g.slot === "cluster-basics")!.apps.map((a) => a.id)).not.toContain("longhorn");
  });

  it("shows what discovery found and offers Deploy only for what is missing", async () => {
    stubApi();
    renderWithApp(<DeployPage />);
    const longhorn = await card("longhorn");
    expect(longhorn.dataset.detectState).toBe("installed");
    expect(within(longhorn).getByText("https://longhorn.example.test")).toBeInTheDocument();
    expect(within(longhorn).queryByRole("button", { name: "Deploy" })).toBeNull();
    expect(within(longhorn).getByText(/Apps > Installed/)).toBeInTheDocument();

    const metrics = await card("metrics-server");
    expect(within(metrics).getByText("unknown")).toBeInTheDocument();
    expect(within(metrics).getByText(/could not be listed/)).toBeInTheDocument();

    const rancher = await card("rancher");
    expect(within(rancher).getByText("not installed")).toBeInTheDocument();
    expect(within(rancher).getByText("Needs cert-manager")).toBeInTheDocument();
    expect(within(rancher).getByRole("button", { name: "Deploy" })).toBeInTheDocument();

    expect(screen.getByRole("region", { name: "Cluster basics" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Remote access" })).toBeInTheDocument();
  });

  it("lists recent deploys and opens a job's log", async () => {
    stubApi({ "GET /api/deploy/jobs/:id": mockFailedJob });
    stubEventSource();
    renderWithApp(<DeployPage />);
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-job="${mockFailedJob.id}"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    expect(within(row).getByText("failed")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Log" }));
    await waitFor(() => expect(screen.getByTestId("deploy-log")).toHaveTextContent("Happy Helming"));
  });

  it("says deploys are off with the line that turns them on", async () => {
    stubApi({ "GET /api/deploy/status": mockDeployDisabled });
    renderWithApp(<DeployPage />);
    expect(await screen.findByText("Deploys are off")).toBeInTheDocument();
    expect(screen.getByText(mockDeployDisabled.enableHint!)).toBeInTheDocument();
  });

  it("forces a new look when asked", async () => {
    const { calls } = stubApi();
    renderWithApp(<DeployPage />);
    await card("longhorn");
    fireEvent.click(screen.getByRole("button", { name: "Look again" }));
    await waitFor(() =>
      expect(calls.some((c) => c.key === "GET /api/catalog/apps" && c.url.searchParams.get("refresh") === "1")).toBe(
        true
      )
    );
  });

  it("has the catalog, templates and external service as tabs", async () => {
    stubApi();
    renderWithApp(<DeployPage />);
    expect(await screen.findByRole("tab", { name: "Catalog", selected: true })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Templates and custom apps" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "External service" })).toBeInTheDocument();
  });
});

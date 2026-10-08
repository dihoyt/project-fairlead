import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { mockBlockedPlan, mockDeployDisabled, mockDeployPlan, mockCatalogApps } from "@contracts/mocks/catalog";
import { apiMocks } from "../../mocks/api";
import { SessionContext, type Session } from "../../session";
import { renderWithApp } from "../../../test-utils";
import { DeployButton } from "../DeployButton";
import { stubApi, stubEventSource } from "./stubApi";

function session(admin: boolean): Session {
  return { me: { ...apiMocks["GET /api/me"], admin }, methods: null, refresh: () => {} };
}

const rancher = mockCatalogApps.find((app) => app.id === "rancher")!;

describe("DeployButton", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("explains that deploys are off and shows the line that turns them on", async () => {
    stubApi({ "GET /api/deploy/status": mockDeployDisabled });
    renderWithApp(<DeployButton appId="headlamp" />);
    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));
    expect(await screen.findByText(mockDeployDisabled.enableHint!)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("walks inputs, preview and install, then reports the deployed URL", async () => {
    const { calls } = stubApi();
    stubEventSource();
    const onDeployed = vi.fn();
    renderWithApp(<DeployButton appId="headlamp" label="Deploy Headlamp" onDeployed={onDeployed} />);
    fireEvent.click(screen.getByRole("button", { name: "Deploy Headlamp" }));

    const host = await screen.findByLabelText(/Hostname/);
    expect(host).toHaveValue("headlamp.example.test");
    expect(screen.getByText(/lightweight web UI/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(/helm upgrade --install headlamp/)).toBeInTheDocument();
    expect(screen.getAllByText("https://headlamp.example.test").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(onDeployed).toHaveBeenCalledTimes(1));
    expect(onDeployed).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "headlamp", url: "https://headlamp.example.test" })
    );
    const post = calls.find((c) => c.key === "POST /api/deploy/jobs");
    expect(post?.body).toEqual({
      appId: "headlamp",
      namespace: "headlamp",
      inputs: { host: "headlamp.example.test" },
      mode: "install",
    });
    expect(await screen.findByText(/Happy Helming/, { selector: "pre" })).toBeInTheDocument();
  });

  it("keeps the user on the form while an input is invalid", async () => {
    stubApi({ "GET /api/catalog/apps/:id": rancher, "POST /api/deploy/plan": mockBlockedPlan });
    renderWithApp(<DeployButton appId="rancher" />);
    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));
    const password = await screen.findByLabelText(/First admin password/);
    // A masked value from the plan is never put back into a field.
    expect(password).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText("required")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("shows why a plan is blocked and offers no install", async () => {
    const blocked = {
      ...mockDeployPlan,
      appId: "rancher",
      allowed: false,
      blockedBy: "cert-manager must be installed first.",
      missingRequires: ["cert-manager"],
      inputs: { host: "rancher.example.test", bootstrapPassword: "********" },
    };
    stubApi({ "GET /api/catalog/apps/:id": rancher, "POST /api/deploy/plan": blocked });
    renderWithApp(<DeployButton appId="rancher" />);
    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));
    fireEvent.change(await screen.findByLabelText(/First admin password/), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(blocked.blockedBy)).toBeInTheDocument();
    expect(screen.getByText(/cert-manager must be installed before this one/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Dry run" })).toBeDisabled();
  });

  it("starts a dry run and shows its progress beside the preview", async () => {
    const { calls } = stubApi({
      "POST /api/deploy/jobs": { ...apiMocks["POST /api/deploy/jobs"], mode: "dry-run" },
      "GET /api/deploy/jobs/:id": { ...apiMocks["GET /api/deploy/jobs/:id"], mode: "dry-run" },
    });
    stubEventSource();
    const onDeployed = vi.fn();
    renderWithApp(<DeployButton appId="headlamp" onDeployed={onDeployed} />);
    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));
    await screen.findByLabelText(/Hostname/);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    fireEvent.click(await screen.findByRole("button", { name: "Dry run" }));
    expect(await screen.findByText("dry run succeeded")).toBeInTheDocument();
    expect(calls.find((c) => c.key === "POST /api/deploy/jobs")?.body).toMatchObject({ mode: "dry-run" });
    expect(screen.getByRole("button", { name: "Install" })).toBeEnabled();
    expect(onDeployed).not.toHaveBeenCalled();
  });

  it("is disabled for someone who is not an admin", () => {
    stubApi();
    renderWithApp(
      <SessionContext.Provider value={session(false)}>
        <DeployButton appId="headlamp" />
      </SessionContext.Provider>
    );
    expect(screen.getByRole("button", { name: "Deploy" })).toBeDisabled();
  });
});

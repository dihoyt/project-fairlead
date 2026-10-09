import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { mockMe } from "@contracts/mocks/api";
import {
  mockCordonPlan,
  mockDrainJob,
  mockDrainPlan,
  mockNodeSummaries,
  mockRebootBlockedPlan,
} from "@contracts/mocks/nodes";
import { apiMocks } from "../../../ui/mocks/api";
import { SessionContext } from "../../../ui/session";
import { stubApi, stubEventSource } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { NodeActions } from "../NodeActions";
import { NodeTable } from "../NodeTable";

function asUser(ui: ReactElement, admin = true) {
  return renderWithApp(
    <SessionContext.Provider value={{ me: { ...mockMe, admin }, methods: null, refresh: () => undefined }}>
      {ui}
    </SessionContext.Provider>
  );
}

const [node1, node2] = mockNodeSummaries;

describe("NodeActions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders nothing for a non-admin", () => {
    stubApi();
    asUser(<NodeActions node={node1!} />, false);
    expect(screen.queryByRole("button", { name: "Actions" })).not.toBeInTheDocument();
  });

  it("offers uncordon for a cordoned node and cordon otherwise", async () => {
    stubApi();
    asUser(<NodeActions node={node2!} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(await screen.findByRole("menuitem", { name: "Uncordon" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Cordon" })).not.toBeInTheDocument();
  });

  it("previews a drain with its options and each pod's outcome, then follows the job", async () => {
    const { calls } = stubApi({
      "POST /api/deploy/actions/plan": mockDrainPlan,
      "POST /api/deploy/actions/run": mockDrainJob,
      "GET /api/deploy/jobs/:id": { ...mockDrainJob, state: "succeeded" },
    });
    stubEventSource(["node/node-2 cordoned", "evicting pod apps/web-6d4f-x7k2p"]);
    asUser(<NodeActions node={node2!} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Drain" }));

    expect(await screen.findByText("apps/postgres-0")).toBeInTheDocument();
    expect(screen.getByText(/PodDisruptionBudget postgres/)).toBeInTheDocument();
    expect(screen.getByText(/runs this console's own pod/)).toBeInTheDocument();
    expect(calls.find((c) => c.key === "POST /api/deploy/actions/plan")?.body).toEqual({
      kind: "node-drain",
      node: "node-2",
      ignoreDaemonSets: true,
      deleteEmptyDirData: false,
      timeoutSeconds: 300,
    });

    fireEvent.click(screen.getByRole("checkbox", { name: /Evict pods with emptyDir volumes/ }));
    await waitFor(() =>
      expect(calls.filter((c) => c.key === "POST /api/deploy/actions/plan").at(-1)?.body).toMatchObject({
        deleteEmptyDirData: true,
      })
    );

    fireEvent.click(await screen.findByRole("button", { name: "Drain node-2" }));
    expect(await screen.findByText("node-2 is drained and stays cordoned.")).toBeInTheDocument();
    expect(calls.find((c) => c.key === "POST /api/deploy/actions/run")?.body).toMatchObject({
      kind: "node-drain",
      node: "node-2",
    });
  });

  it("cordon has no drain options", async () => {
    stubApi({ "POST /api/deploy/actions/plan": mockCordonPlan });
    asUser(<NodeActions node={node1!} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Cordon" }));
    expect(await screen.findByText("kubectl cordon node-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cordon node-1" })).toBeEnabled();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("a blocked reboot says why and can't start", async () => {
    stubApi({ "POST /api/deploy/actions/plan": mockRebootBlockedPlan });
    asUser(<NodeActions node={node1!} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reboot" }));
    expect(await screen.findByText(/only node; draining it would leave nothing/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reboot node-1" })).toBeDisabled();
  });

  it("shows the enable hint when deploys are off", async () => {
    stubApi({ "GET /api/deploy/status": { ...apiMocks["GET /api/deploy/status"], enabled: false } });
    asUser(<NodeActions node={node1!} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Cordon" }));
    expect(await screen.findByText(/Deploying apps from here is turned off/)).toBeInTheDocument();
  });

  it("sits in each node table row without expanding the row", async () => {
    stubApi();
    asUser(<NodeTable nodes={mockNodeSummaries} range="1h" />);
    const buttons = screen.getAllByRole("button", { name: "Actions" });
    expect(buttons).toHaveLength(mockNodeSummaries.length);
    fireEvent.click(buttons[0]!);
    expect(await screen.findByRole("menuitem", { name: "Drain" })).toBeInTheDocument();
    expect(screen.getByTestId("node-row-node-1")).toHaveAttribute("aria-expanded", "false");
  });
});

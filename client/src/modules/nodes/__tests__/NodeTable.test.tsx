import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { apiMocks } from "../../../ui/mocks/api";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { NodeTable, nodeState, uptime } from "../NodeTable";

const nodes = apiMocks["GET /api/metrics-k8s/nodes"];

describe("NodeTable", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows one row per node with its state, version, pods and Longhorn space", () => {
    // Mock boot times are relative to the mocks' fixed now.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
    stubApi();
    renderWithApp(<NodeTable nodes={nodes} range="1h" />);

    const cp = screen.getByTestId("node-row-node-1");
    expect(within(cp).getByText("control-plane")).toBeInTheDocument();
    expect(within(cp).getByText("Ready")).toBeInTheDocument();
    expect(within(cp).getByText("34/110")).toBeInTheDocument();
    expect(within(cp).getByText("12d")).toBeInTheDocument();
    expect(within(cp).getByText("69 GiB")).toBeInTheDocument();

    const cordoned = screen.getByTestId("node-row-node-2");
    expect(within(cordoned).getByText("Cordoned")).toBeInTheDocument();
    expect(within(cordoned).getByLabelText("Pressure: DiskPressure")).toBeInTheDocument();
    expect(within(cordoned).getByText("drift")).toBeInTheDocument();
    expect(within(cordoned).getByText("91.4%")).toBeInTheDocument();

    expect(within(screen.getByTestId("node-row-node-3")).getByText("Not Ready")).toBeInTheDocument();
    expect(screen.getByText("Load")).toBeInTheDocument();
    expect(screen.getByText("Longhorn")).toBeInTheDocument();
  });

  it("leaves out the load and Longhorn columns when no node has them", () => {
    stubApi();
    const plain = nodes.map(({ load1: _l, longhornAvailableBytes: _b, spark, ...n }) => ({
      ...n,
      ...(spark ? { spark: { cpu: spark.cpu } } : {}),
    }));
    renderWithApp(<NodeTable nodes={plain} range="1h" />);
    expect(screen.queryByText("Load")).not.toBeInTheDocument();
    expect(screen.queryByText("Longhorn")).not.toBeInTheDocument();
  });

  it("expands a row into the node's charts and collapses it again", async () => {
    stubApi();
    renderWithApp(<NodeTable nodes={nodes} range="1h" />);
    const row = screen.getByTestId("node-row-node-2");
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("Network")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Containers and pods on node-2" })).toHaveAttribute(
      "href",
      "/nodes/node-2"
    );
    fireEvent.click(row);
    expect(screen.queryByText("Network")).not.toBeInTheDocument();
  });
});

describe("node helpers", () => {
  it("orders state as Not Ready, then cordoned, then Ready", () => {
    expect(nodeState({ ...nodes[0]!, ready: false, schedulable: false }).label).toBe("Not Ready");
    expect(nodeState({ ...nodes[0]!, schedulable: false }).label).toBe("Cordoned");
    expect(nodeState(nodes[0]!).label).toBe("Ready");
  });

  it("formats uptime compactly", () => {
    const now = Date.parse("2026-10-07T12:00:00Z");
    expect(uptime("2026-10-07T11:20:00Z", now)).toBe("40m");
    expect(uptime("2026-10-06T00:00:00Z", now)).toBe("36h");
    expect(uptime("2026-09-25T00:00:00Z", now)).toBe("12d");
    expect(uptime(undefined, now)).toBeUndefined();
  });
});

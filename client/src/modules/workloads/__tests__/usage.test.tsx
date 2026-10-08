import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import type { NamespaceUsage, NamespaceView } from "@contracts/workloads";
import { mockSpaceUsage } from "@contracts/mocks/workloads";
import { SeriesSourceProvider, mockSeriesFetcher } from "../../../ui";
import { apiMocks } from "../../../ui/mocks/api";
import { renderWithApp } from "../../../test-utils";
import { MemoryRouter, Route, Routes } from "react-router";
import { MantineProvider } from "@mantine/core";
import { render } from "@testing-library/react";
import { theme } from "../../../theme";
import { SpacePage } from "../SpacePage";
import { sortSpaces } from "../SpacesPage";
import { UsageBar, formatCpu, judge } from "../usage";

const MiB = 2 ** 20;

const space = (name: string): NamespaceView => ({
  name,
  status: "Active",
  workloads: 1,
  pods: 1,
  unhealthyPods: 0,
  managedBy: null,
  createdAt: "",
});

describe("usage helpers", () => {
  it("formats CPU in millicores below one core", () => {
    expect(formatCpu(0.25)).toBe("250m");
    expect(formatCpu(1.5)).toBe("1.50 cores");
  });

  it("judges against the limit first, then the request", () => {
    expect(judge({ current: 0.95, request: 0.5, limit: 1 })).toMatchObject({ against: "limit", color: "red" });
    expect(judge({ current: 0.6, request: 0.5, limit: 1 })).toMatchObject({ against: "limit", color: "yellow" });
    expect(judge({ current: 0.2, request: 0.5 })).toMatchObject({ against: "request", color: "cyan" });
    expect(judge({ current: 0.2 })).toEqual({ color: "cyan" });
  });

  it("sorts spaces by usage with missing values last", () => {
    const usage = new Map<string, NamespaceUsage>([
      ["a", { namespace: "a", cpu: { current: 0.1 }, memory: {} }],
      ["b", { namespace: "b", cpu: { avg: 0.5 }, memory: {} }],
    ]);
    const spaces = [space("c"), space("a"), space("b")];
    expect(sortSpaces(spaces, usage, { key: "cpu", dir: "desc" }).map((s) => s.name)).toEqual(["b", "a", "c"]);
    expect(sortSpaces(spaces, usage, { key: "cpu", dir: "asc" }).map((s) => s.name)).toEqual(["a", "b", "c"]);
  });

  it("shows the value and what it is measured against", () => {
    renderWithApp(<UsageBar resource="memory" usage={{ current: 900 * MiB, request: 512 * MiB, limit: 1024 * MiB }} />);
    expect(screen.getByText("900 MiB")).toBeInTheDocument();
    expect(screen.getByText("of 1.0 GiB limit")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "memory 88% of limit" })).toBeInTheDocument();
  });
});

describe("SpacePage", () => {
  afterEach(() => vi.unstubAllGlobals());
  // jsdom has no layout, so no scrolling; the log viewer scrolls to its end.
  Element.prototype.scrollTo ??= () => {};

  it("shows pod usage and opens a pod in a drawer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
        const path = new URL(String(input)).pathname;
        const body = path.endsWith("/usage")
          ? mockSpaceUsage
          : path.endsWith("/events")
            ? apiMocks["GET /api/workloads/namespaces/:namespace/events"]
            : path.endsWith("/links")
              ? {}
              : path.endsWith("/logs")
                ? apiMocks["GET /api/workloads/namespaces/:namespace/pods/:pod/logs"]
                : /\/pods\/[^/]+$/.test(path)
                  ? apiMocks["GET /api/workloads/namespaces/:namespace/pods/:pod"]
                  : path.endsWith("/pods")
                    ? apiMocks["GET /api/workloads/namespaces/:namespace/pods"]
                    : apiMocks["GET /api/workloads/namespaces/:namespace/workloads"];
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      })
    );
    render(
      <MantineProvider theme={theme} defaultColorScheme="dark">
        <SeriesSourceProvider fetcher={mockSeriesFetcher}>
          <MemoryRouter initialEntries={["/workloads/media?tab=pods"]}>
            <Routes>
              <Route path="/workloads/:namespace" element={<SpacePage />} />
            </Routes>
          </MemoryRouter>
        </SeriesSourceProvider>
      </MantineProvider>
    );
    const name = await screen.findByRole("button", { name: "jellyfin-7c9d8" });
    expect(await screen.findAllByText(/of 1\.0 GiB limit/)).not.toHaveLength(0);
    fireEvent.click(name);
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText("Open pod page")).toBeInTheDocument();
    expect(await within(drawer).findByText("BackOff")).toBeInTheDocument();
  });
});

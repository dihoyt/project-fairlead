import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { mockCheckResults } from "@contracts/mocks/health";
import { renderWithApp } from "../../test-utils";
import { CheckList, SeriesSourceProvider, StatusBadge, Tile, TimeSeriesChart, mockSeriesFetcher } from "..";
import { toRows } from "../TimeSeriesChart";

describe("Tile", () => {
  it("shows title, status, summary and issue counts, linking when given a route", () => {
    renderWithApp(
      <Tile
        title="Storage"
        status="warn"
        summary="1 volume degraded"
        count={{ crit: 2, warn: 1 }}
        to="/health/storage"
      />
    );
    expect(screen.getByText("Storage")).toBeInTheDocument();
    expect(screen.getByText("1 volume degraded")).toBeInTheDocument();
    expect(screen.getByText("2 critical")).toBeInTheDocument();
    expect(screen.getByText("1 warning")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/health/storage");
  });

  it("is not a link without a route", () => {
    renderWithApp(<Tile title="Hosts" status="ok" summary="All reachable" />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("StatusBadge", () => {
  it("carries the status and lets a label override the text", () => {
    renderWithApp(<StatusBadge status="absent" label="not installed" />);
    const badge = screen.getByText("not installed");
    expect(badge.closest("[data-status]")).toHaveAttribute("data-status", "absent");
  });
});

describe("CheckList", () => {
  it("says so when empty", () => {
    renderWithApp(<CheckList results={[]} />);
    expect(screen.getByText("No checks.")).toBeInTheDocument();
  });

  it("shows detail for every result and raw output only for failures by default", () => {
    const results = Object.values(mockCheckResults);
    renderWithApp(<CheckList results={results} />);
    for (const result of results) {
      const row = document.querySelector(`[data-check="${result.id}"]`) as HTMLElement;
      expect(within(row).getByText(result.detail)).toBeInTheDocument();
    }
    const raws = results.filter((r) => r.raw !== undefined);
    const failing = raws.filter((r) => r.status === "crit" || r.status === "warn");
    expect(document.querySelectorAll("pre").length).toBe(failing.length);
  });
});

describe("TimeSeriesChart", () => {
  it("merges series sampled at different instants into one row per timestamp", () => {
    const rows = toRows(
      [
        {
          series: "a",
          labels: {},
          points: [
            [1, 10],
            [3, 30],
          ],
        },
        {
          series: "b",
          labels: {},
          points: [
            [2, 20],
            [3, 31],
          ],
        },
      ],
      ["a", "b"]
    );
    expect(rows).toEqual([
      { ts: 1, a: 10 },
      { ts: 2, b: 20 },
      { ts: 3, a: 30, b: 31 },
    ]);
  });

  it("replaces the skeleton with a chart, not the empty state, on mock series", async () => {
    const { container } = renderWithApp(
      <SeriesSourceProvider fetcher={mockSeriesFetcher}>
        <TimeSeriesChart queries={[{ series: "node.cpu.percent" }]} range="1h" unit="percent" />
      </SeriesSourceProvider>
    );
    await waitFor(() => expect(container.querySelector(".mantine-Skeleton-root")).toBeNull());
    expect(screen.queryByText("No data for this range yet.")).toBeNull();
  });
});

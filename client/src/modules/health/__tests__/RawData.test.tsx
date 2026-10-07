import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { CheckResult } from "@contracts/health";
import { renderWithApp } from "../../../test-utils";
import { RawData } from "../CategoryPage";

const result = (status: CheckResult["status"]): CheckResult => ({
  id: "pvc/apps/data",
  label: "apps/data",
  status,
  detail: "Not covered by any backup",
  raw: { pvc: { name: "data-marker" } },
  observedAt: "2026-10-07T00:00:00Z",
});

describe("RawData", () => {
  it("keeps a failing check's raw data collapsed until asked for", () => {
    renderWithApp(<RawData result={result("crit")} />);
    const toggle = screen.getByRole("button", { name: "Show raw data" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide raw data" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/data-marker/)).toBeInTheDocument();
  });

  it("offers nothing for a passing check", () => {
    renderWithApp(<RawData result={result("ok")} />);
    expect(screen.queryByRole("button", { name: "Show raw data" })).toBeNull();
  });
});

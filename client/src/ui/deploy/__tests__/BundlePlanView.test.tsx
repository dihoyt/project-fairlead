import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { mockBundlePlan, mockBundlePlanNoRoom } from "@contracts/mocks/catalog";
import { renderWithApp } from "../../../test-utils";
import { BundlePlanView } from "../BundlePlanView";

describe("BundlePlanView disk check", () => {
  it("states what the rollout needs when it fits", () => {
    renderWithApp(<BundlePlanView plan={mockBundlePlan} />);
    expect(screen.getByText(/Needs about .* free of 200 GiB between them/)).toBeInTheDocument();
  });

  it("warns when little disk would be left", () => {
    const plan = {
      ...mockBundlePlan,
      disk: { ...mockBundlePlan.disk!, status: "warn" as const, detail: "Leaves 9% free." },
    };
    renderWithApp(<BundlePlanView plan={plan} />);
    expect(screen.getByText("Low on disk")).toBeInTheDocument();
    expect(screen.getByText("Leaves 9% free.")).toBeInTheDocument();
  });

  it("blocks with the reason when the disk is too small", () => {
    renderWithApp(<BundlePlanView plan={mockBundlePlanNoRoom} />);
    expect(screen.getByText("Can't roll out yet")).toBeInTheDocument();
    expect(screen.getByText(/GiB short: free some space or add disk/)).toBeInTheDocument();
  });
});

describe("BundlePlanView memory", () => {
  it("shows each app's memory and the total", () => {
    const MiB = 1024 ** 2;
    const [first, ...rest] = mockBundlePlan.steps.filter((step) => !step.skip);
    const plan = {
      ...mockBundlePlan,
      steps: [{ ...first!, memoryBytes: 1056 * MiB }, ...rest],
      memoryBytes: 1216 * MiB,
    };
    renderWithApp(<BundlePlanView plan={plan} />);
    expect(screen.getByText(/ask for about 1.2 GiB of memory between them/)).toBeInTheDocument();
    expect(screen.getByText("1 GiB")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-step-memory]")).toHaveLength(1);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockSeedDone, mockSeedNone, mockSeedPending } from "@contracts/mocks/seed";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { SeedSummary, seedNeedsAttention } from "../SeedSummary";

describe("SeedSummary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("applies a pending seed once on its own and shows each item's result", async () => {
    const { calls } = stubApi({
      "GET /api/onboarding/seed": mockSeedPending,
      "POST /api/onboarding/seed/apply": mockSeedDone,
    });
    renderWithApp(<SeedSummary />);
    expect(await screen.findByText("nas.example.com:445: connection refused.")).toBeInTheDocument();
    expect(screen.getByText("Set up from your file")).toBeInTheDocument();
    expect(screen.getAllByText("Failed")).toHaveLength(1);
    expect(calls.filter((c) => c.key === "POST /api/onboarding/seed/apply")).toHaveLength(1);
  });

  it("shows nothing when the install was not set up from a file", async () => {
    const { calls } = stubApi({ "GET /api/onboarding/seed": mockSeedNone });
    const { container } = renderWithApp(<SeedSummary />);
    await waitFor(() => expect(calls.some((c) => c.key === "GET /api/onboarding/seed")).toBe(true));
    expect(container.querySelector("[data-seed-summary]")).toBeNull();
  });

  it("dismissing hides it", async () => {
    stubApi({ "GET /api/onboarding/seed": mockSeedDone });
    renderWithApp(<SeedSummary />);
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText("Set up from your file")).toBeNull());
  });

  it("needs attention while pending or until dismissed", () => {
    expect(seedNeedsAttention(mockSeedPending)).toBe(true);
    expect(seedNeedsAttention(mockSeedDone)).toBe(true);
    expect(seedNeedsAttention({ ...mockSeedDone, dismissed: true })).toBe(false);
    expect(seedNeedsAttention(mockSeedNone)).toBe(false);
  });
});

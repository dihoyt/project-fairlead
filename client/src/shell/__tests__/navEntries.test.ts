import { describe, expect, it } from "vitest";
import { navEntries } from "../Layout";

describe("navEntries", () => {
  it("gathers a group's items at its first item's place, each part in order", () => {
    const entries = navEntries([
      { label: "Workloads", to: "/workloads", order: 70 },
      { label: "Deploy", to: "/apps/deploy", order: 61, group: "Apps" },
      { label: "Health", to: "/health", order: 10 },
      { label: "Installed", to: "/apps/installed", order: 60, group: "Apps" },
    ]);
    expect(
      entries.map((e) => ("item" in e ? e.item.label : `${e.group}: ${e.items.map((i) => i.label).join(", ")}`))
    ).toEqual(["Health", "Apps: Installed, Deploy", "Workloads"]);
  });
});

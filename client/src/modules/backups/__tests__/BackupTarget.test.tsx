import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { DetectState } from "@contracts/catalog";
import { apiMocks } from "../../../ui/mocks/api";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { LonghornBackupTarget } from "../BackupTarget";

const app = apiMocks["GET /api/catalog/apps/:id"];

function serve(longhorn: DetectState, target: DetectState) {
  stubApi({
    "GET /api/catalog/apps/:id": (url: URL) => {
      const id = decodeURIComponent(url.pathname.split("/").pop()!);
      const state = id === "longhorn" ? longhorn : target;
      return { ...app, id, detected: { ...app.detected, appId: id, state } };
    },
  });
}

describe("LonghornBackupTarget", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers to set a target when Longhorn has none", async () => {
    serve("installed", "not-installed");
    renderWithApp(<LonghornBackupTarget />);
    expect(await screen.findByText("Set a Longhorn backup target")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set backup target" })).toBeInTheDocument();
  });

  it("stays quiet with a target set or without Longhorn", async () => {
    serve("installed", "installed");
    const { unmount } = renderWithApp(<LonghornBackupTarget />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Set a Longhorn backup target")).toBeNull();
    unmount();
    serve("not-installed", "not-installed");
    renderWithApp(<LonghornBackupTarget />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Set a Longhorn backup target")).toBeNull();
  });
});

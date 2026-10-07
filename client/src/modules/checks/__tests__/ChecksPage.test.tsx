import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { mockCheck, mockInsecureCheck } from "@contracts/mocks/api";
import { SeriesSourceProvider, mockSeriesFetcher } from "../../../ui";
import { SessionContext, type Session } from "../../../ui/session";
import { apiMocks } from "../../../ui/mocks/api";
import { renderWithApp } from "../../../test-utils";
import { ChecksPage } from "../ChecksPage";

function session(admin: boolean): Session {
  return { me: { ...apiMocks["GET /api/me"], admin }, methods: null, refresh: () => {} };
}

function renderPage(admin: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify([mockCheck, mockInsecureCheck]), { status: 200 }))
  );
  return renderWithApp(
    <SessionContext.Provider value={session(admin)}>
      <SeriesSourceProvider fetcher={mockSeriesFetcher}>
        <ChecksPage />
      </SeriesSourceProvider>
    </SessionContext.Provider>
  );
}

describe("ChecksPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists checks from the API with target, detail and TLS flags", async () => {
    renderPage(true);
    expect(await screen.findByText(mockCheck.label)).toBeInTheDocument();
    expect(screen.getByText(mockCheck.target)).toBeInTheDocument();
    expect(screen.getByText(mockCheck.last!.detail)).toBeInTheDocument();
    expect(screen.getByText(mockInsecureCheck.label)).toBeInTheDocument();
    expect(screen.getByText("unverified TLS")).toBeInTheDocument();
  });

  it("offers write actions to admins only", async () => {
    const admin = renderPage(true);
    await screen.findByText(mockCheck.label);
    expect(screen.getByRole("button", { name: "Add check" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Delete" }).length).toBe(2);
    admin.unmount();

    renderPage(false);
    await screen.findByText(mockCheck.label);
    expect(screen.queryByRole("button", { name: "Add check" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});

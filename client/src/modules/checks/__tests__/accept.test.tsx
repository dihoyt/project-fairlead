import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { CheckView } from "@contracts/checks";
import { mockCheck, mockInsecureCheck } from "@contracts/mocks/api";
import { SeriesSourceProvider, mockSeriesFetcher } from "../../../ui";
import { SessionContext, type Session } from "../../../ui/session";
import { apiMocks } from "../../../ui/mocks/api";
import { renderWithApp } from "../../../test-utils";
import { ChecksPage } from "../ChecksPage";
import { acceptStatusRequest, unexpectedStatus } from "../accept";

const gated: CheckView = {
  ...mockInsecureCheck,
  id: "chk_gitea",
  label: "Gitea",
  target: "https://git.example.com/",
  last: {
    id: "chk_gitea",
    label: "Gitea",
    status: "warn",
    value: 72,
    detail: "HTTP 401 in 72 ms; up, login required. Accept this status if the login is expected",
    raw: { target: "https://git.example.com/", httpStatus: 401 },
    observedAt: mockCheck.last!.observedAt,
  },
};

describe("accepting a status", () => {
  it("finds the status that made an http check warn or fail", () => {
    expect(unexpectedStatus(gated)).toBe(401);
    expect(unexpectedStatus(mockCheck)).toBeUndefined();
    const listed = { ...gated, expectStatus: [200, 401] };
    expect(unexpectedStatus(listed)).toBeUndefined();
    const bodyMiss = { ...gated, last: { ...gated.last!, status: "crit" as const, raw: { httpStatus: 200 } } };
    expect(unexpectedStatus(bodyMiss)).toBeUndefined();
    const down = { ...gated, last: { ...gated.last!, status: "crit" as const, raw: { httpStatus: 503 } } };
    expect(unexpectedStatus(down)).toBeUndefined();
  });

  it("keeps the usual 2xx and 3xx when nothing was listed, and leaves the secret alone", () => {
    const req = acceptStatusRequest(gated, 401);
    expect(req.expectStatus).toEqual([200, 204, 301, 302, 303, 307, 308, 401]);
    expect(req).not.toHaveProperty("secret");
    expect(req.insecureSkipVerify).toBe(true);
    expect(acceptStatusRequest({ ...gated, expectStatus: [204] }, 403).expectStatus).toEqual([204, 403]);
  });

  it("saves the status and re-runs the check from the row", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response(JSON.stringify(gated), { status: 200 });
      if (init?.method === "POST") return new Response(JSON.stringify(gated.last), { status: 200 });
      return new Response(JSON.stringify([mockCheck, gated]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const session: Session = { me: { ...apiMocks["GET /api/me"], admin: true }, methods: null, refresh: () => {} };
    renderWithApp(
      <SessionContext.Provider value={session}>
        <SeriesSourceProvider fetcher={mockSeriesFetcher}>
          <ChecksPage />
        </SeriesSourceProvider>
      </SessionContext.Provider>
    );
    const buttons = await screen.findAllByRole("button", { name: "Accept this status" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(String(put?.[0])).toContain("api/checks/chk_gitea");
    expect(JSON.parse(String(put?.[1]?.body)).expectStatus).toContain(401);
  });

  afterEach(() => vi.unstubAllGlobals());
});

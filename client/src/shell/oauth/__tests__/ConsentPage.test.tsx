import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router";
import { theme } from "../../../theme";
import { apiMocks } from "../../../ui/mocks/api";
import { oidcStartUrl } from "../../auth/SignInPage";
import { ConsentPage, paramsOf } from "../ConsentPage";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const QUERY =
  "?response_type=code&client_id=cli_1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&code_challenge=abc&code_challenge_method=S256&state=s1&scope=write";

function serve(answer: (body: { decision: string; scope?: string }) => Response) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    answer(JSON.parse(String(init?.body)))
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage(navigate: (url: string) => void) {
  return render(
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <MemoryRouter initialEntries={[`/oauth/consent${QUERY}`]}>
        <ConsentPage navigate={navigate} />
      </MemoryRouter>
    </MantineProvider>
  );
}

describe("ConsentPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the authorize query", () => {
    expect(paramsOf(QUERY)).toMatchObject({ client_id: "cli_1", state: "s1", scope: "write" });
  });

  it("names the client, preselects the requested scope, and sends the browser back on approve", async () => {
    const preview = apiMocks["POST /api/admin/oauth/consent"];
    const fetchMock = serve((body) =>
      json(body.decision === "approve" ? { ...preview, redirect: "https://claude.ai/cb?code=c&state=s1" } : preview)
    );
    const navigate = vi.fn();
    renderPage(navigate);
    expect(await screen.findByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("claude.ai")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Read only"));
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://claude.ai/cb?code=c&state=s1"));
    const approve = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));
    expect(approve).toMatchObject({ decision: "approve", scope: "read", params: { client_id: "cli_1" } });
  });

  it("shows why a request is refused", async () => {
    serve(() => json({ error: "Admins only." }, 403));
    renderPage(vi.fn());
    expect(await screen.findByText("Admins only.")).toBeInTheDocument();
  });
});

describe("oidcStartUrl", () => {
  it("carries the current route through the provider", () => {
    expect(oidcStartUrl("#/oauth/consent?client_id=x")).toContain(
      `rd=${encodeURIComponent("/#/oauth/consent?client_id=x")}`
    );
    expect(oidcStartUrl("")).not.toContain("rd=");
    expect(oidcStartUrl("#/")).not.toContain("rd=");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithApp } from "../../../test-utils";
import { apiMocks } from "../../../ui/mocks/api";
import { TokensPage, claudeCommand } from "../TokensPage";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function serve() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api/admin/tokens") && init?.method === "POST") return json(apiMocks["POST /api/admin/tokens"]);
    if (url.includes("api/admin/tokens") && init?.method === "DELETE") return json({ ok: true });
    if (url.includes("api/admin/tokens") && init?.method === "PATCH") {
      return json(apiMocks["PATCH /api/admin/tokens/:id"]);
    }
    if (url.includes("api/workloads/namespaces")) return json(apiMocks["GET /api/workloads/namespaces"]);
    if (url.includes("api/admin/tokens")) return json(apiMocks["GET /api/admin/tokens"]);
    if (url.includes("api/admin/overview")) {
      return json({
        ...apiMocks["GET /api/admin/overview"],
        publicUrl: { value: "https://console.example.com", source: "ui" },
      });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("TokensPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists tokens by prefix and shows the MCP endpoint", async () => {
    serve();
    renderWithApp(<TokensPage />);
    expect(await screen.findByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("api_Xk3d…")).toBeInTheDocument();
    expect(await screen.findByText("https://console.example.com/mcp")).toBeInTheDocument();
  });

  it("creates a token and shows its secret once with the Claude Code command", async () => {
    const fetchMock = serve();
    renderWithApp(<TokensPage />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "laptop" } });
    fireEvent.click(screen.getByText("Create token"));
    const secret = apiMocks["POST /api/admin/tokens"].secret;
    expect(await screen.findByText(secret)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(claudeCommand("https://console.example.com", secret))).toBeInTheDocument()
    );
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ name: "laptop", scope: "read", expiresInDays: 90 });
  });

  it("revokes a token", async () => {
    const fetchMock = serve();
    renderWithApp(<TokensPage />);
    fireEvent.click((await screen.findAllByText("Revoke"))[0]!);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url, init]) => String(url).includes("tokens/tok_1") && init?.method === "DELETE")
      ).toBe(true)
    );
  });

  it("shows each token's reach and limits a new one to some areas", async () => {
    const fetchMock = serve();
    renderWithApp(<TokensPage />);
    expect(
      await screen.findByText("Workloads, pods and logs, Apps, catalog and templates; namespaces apps, staging")
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "ci" } });
    fireEvent.click(screen.getAllByText("Only some")[0]!);
    expect(screen.getByText("Pick at least one area.")).toBeInTheDocument();
    expect(screen.getByText("Create token").closest("button")).toBeDisabled();
    fireEvent.click(screen.getByText("Hosts"));
    fireEvent.click(screen.getByText("Create token"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      name: "ci",
      scope: "read",
      expiresInDays: 90,
      areas: ["hosts"],
    });
  });

  it("edits a token's limits", async () => {
    const fetchMock = serve();
    renderWithApp(<TokensPage />);
    fireEvent.click((await screen.findAllByText("Edit"))[2]!);
    fireEvent.click(await screen.findByText("Save"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(String(patch[0])).toContain("tokens/tok_3");
    expect(JSON.parse(String(patch[1]!.body))).toMatchObject({
      namespaces: ["apps", "staging"],
      areas: ["workloads", "deploy"],
    });
  });
});

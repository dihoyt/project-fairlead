import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithApp } from "../../../test-utils";
import { apiMocks } from "../../../ui/mocks/api";
import { mockFakeKind } from "@contracts/mocks/connectors/views";
import { ConnectorsPage } from "../ConnectorsPage";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function serve() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("api/connectors/kinds")) return json([...apiMocks["GET /api/connectors/kinds"], mockFakeKind]);
    if (url.includes("api/connectors/test"))
      return json({
        ok: false,
        checks: [{ ...apiMocks["POST /api/connectors/test"].checks[0], status: "crit", detail: "Token rejected" }],
      });
    if (url.includes("/reconcile")) return json(apiMocks["POST /api/connectors/:id/reconcile"]);
    if (method === "DELETE") return json(apiMocks["DELETE /api/connectors/:id"]);
    if (method === "POST") return json(apiMocks["POST /api/connectors"]);
    return json(apiMocks["GET /api/connectors"]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ConnectorsPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows each connector with its checks and what it keeps in sync", async () => {
    serve();
    renderWithApp(<ConnectorsPage />);
    expect(await screen.findByText("Token is active")).toBeInTheDocument();
    expect(screen.getByText("not ours, left alone")).toBeInTheDocument();
    expect(screen.getByText("Sync now")).toBeInTheDocument();
  });

  it("offers only kinds that can take another instance", async () => {
    serve();
    renderWithApp(<ConnectorsPage />);
    await screen.findByText("Token is active");
    expect(screen.getByRole("button", { name: "Fake tool" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cloudflare" })).toBeNull();
  });

  it("tests and adds a connector from its fields, secrets as password inputs", async () => {
    const fetchMock = serve();
    renderWithApp(<ConnectorsPage />);
    await screen.findByText("Token is active");
    fireEvent.click(screen.getByRole("button", { name: "Fake tool" }));
    const form = within(document.querySelector<HTMLElement>('[data-connector-form="fake"]')!);
    const token = form.getByLabelText(/^Token/);
    expect(token).toHaveAttribute("type", "password");
    fireEvent.change(token, { target: { value: "bad" } });
    fireEvent.change(form.getByLabelText(/^Zone/), { target: { value: "example.test" } });
    fireEvent.click(form.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("Token rejected")).toBeInTheDocument();
    fireEvent.click(form.getByRole("button", { name: "Add" }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) => String(url).endsWith("api/connectors") && init?.method === "POST"
      );
      expect(JSON.parse(String(post![1]!.body))).toEqual({
        kind: "fake",
        name: "Fake tool",
        values: { token: "bad", zone: "example.test" },
      });
    });
  });

  it("removes with cleanup ticked by default", async () => {
    const fetchMock = serve();
    renderWithApp(<ConnectorsPage />);
    await screen.findByText("Token is active");
    fireEvent.click(screen.getByText("Remove"));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByRole("checkbox")).toBeChecked();
    fireEvent.click(dialog.getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      const del = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE");
      expect(String(del![0])).toContain("cleanup=1");
    });
  });
});

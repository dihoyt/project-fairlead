import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { AdminOverview, PublicUrlView } from "@contracts/auth";
import { apiMocks } from "../../../ui/mocks/api";
import { renderWithApp } from "../../../test-utils";
import { PublicUrlField, suggestedPublicUrl } from "../steps/PublicUrlField";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

function serve(publicUrl: PublicUrlView) {
  const overview: AdminOverview = { ...apiMocks["GET /api/admin/overview"], publicUrl };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT") return json({ key: "site.publicUrl", value: JSON.parse(String(init.body)).value });
    if (url.includes("api/admin/overview")) return json(overview);
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("PublicUrlField", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("suggests the page's own address only when nothing is configured", () => {
    expect(
      suggestedPublicUrl({ publicUrl: { value: "http://10.0.0.5:30080", source: "request" } }, "http://here")
    ).toBe("http://here");
    expect(suggestedPublicUrl({ publicUrl: { value: "https://a.example.com", source: "ui" } }, "http://here")).toBe(
      "https://a.example.com"
    );
  });

  it("shows an environment value read-only", async () => {
    serve({ value: "https://env.example.com", source: "env" });
    renderWithApp(<PublicUrlField />);
    const input = await screen.findByDisplayValue("https://env.example.com");
    expect(input).toHaveAttribute("readonly");
    expect(screen.getByText(/Set by the environment/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("prefills from the page's address and saves the setting", async () => {
    const fetchMock = serve({ value: "http://ignored", source: "request" });
    renderWithApp(<PublicUrlField />);
    const input = await screen.findByDisplayValue(window.location.origin);
    fireEvent.change(input, { target: { value: "https://console.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(String(put?.[0])).toContain("api/admin/settings/site.publicUrl");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ value: "https://console.example.com" });
  });
});

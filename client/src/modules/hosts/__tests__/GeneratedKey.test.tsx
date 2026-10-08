import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { HostKeypair } from "@contracts/hosts";
import { apiMocks } from "../../../ui/mocks/api";
import { renderWithApp } from "../../../test-utils";
import { HostForm } from "../HostForm";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubApi(initial: HostKeypair | null) {
  let keypair = initial;
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(url)).pathname + new URL(String(url)).search;
      calls.push({ method, url: path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (path.includes("api/hosts/keypair")) {
        if (method === "POST") keypair = apiMocks["POST /api/hosts/keypair"];
        return json(method === "POST" ? keypair : { keypair });
      }
      if (path.includes("api/hosts/test")) return json(apiMocks["POST /api/hosts/test"]);
      return json({ error: "unexpected" }, 500);
    })
  );
  return calls;
}

describe("HostForm with the generated key", () => {
  // jsdom has no FontFaceSet; Mantine's autosize Textarea listens on it.
  beforeAll(() => {
    if (!document.fonts)
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: { addEventListener: () => {}, removeEventListener: () => {} },
      });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("defaults a new host to the generated key and shows the one-liner", async () => {
    const calls = stubApi(apiMocks["GET /api/hosts/keypair"].keypair);
    const onSubmit = vi.fn(async () => {});
    renderWithApp(<HostForm onSubmit={onSubmit} onCancel={() => {}} />);

    expect(await screen.findByText(apiMocks["GET /api/hosts/keypair"].keypair!.installCommand)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy command" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Private key")).toBeNull();

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "NAS" } });
    fireEvent.change(screen.getByLabelText(/Address/), { target: { value: "nas.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add host" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const req = (onSubmit.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(req).toMatchObject({ auth: "key", useGeneratedKey: true, address: "nas.example.com" });
    expect(req.credential).toBeUndefined();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("generates the key pair when there is none", async () => {
    const calls = stubApi(null);
    renderWithApp(<HostForm onSubmit={async () => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Generate key" }));
    expect(await screen.findByText(apiMocks["POST /api/hosts/keypair"].installCommand)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("api/hosts/keypair"))).toBe(true);
  });

  it("keeps an own key and a password as alternatives", async () => {
    stubApi(apiMocks["GET /api/hosts/keypair"].keypair);
    const onSubmit = vi.fn(async () => {});
    renderWithApp(<HostForm onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.click(screen.getByText("Own key"));
    fireEvent.change(await screen.findByLabelText("Private key"), { target: { value: "KEY" } });
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "NAS" } });
    fireEvent.change(screen.getByLabelText(/Address/), { target: { value: "10.0.0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Add host" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const req = (onSubmit.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(req).toMatchObject({ auth: "key", credential: "KEY" });
    expect(req.useGeneratedKey).toBeUndefined();

    fireEvent.click(screen.getByText("Password"));
    expect(document.querySelector('input[type="password"]')).not.toBeNull();
  });
});

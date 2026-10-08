import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { apiMocks } from "../../../ui/mocks/api";
import { renderWithApp } from "../../../test-utils";
import { HostsStep } from "../steps/HostsStep";

describe("HostsStep", () => {
  // jsdom has no FontFaceSet; Mantine's autosize Textarea listens on it.
  beforeAll(() => {
    if (!document.fonts)
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: { addEventListener: () => {}, removeEventListener: () => {} },
      });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("tests a host with the generated key and shows the one-liner to paste", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        const path = String(url);
        if (init?.body) bodies.push(JSON.parse(String(init.body)));
        const body = path.includes("api/hosts/keypair")
          ? apiMocks["GET /api/hosts/keypair"]
          : path.includes("api/hosts/test")
            ? apiMocks["POST /api/hosts/test"]
            : [];
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      })
    );
    renderWithApp(<HostsStep onFinish={async () => {}} />);

    expect(await screen.findByText(apiMocks["GET /api/hosts/keypair"].keypair!.installCommand)).toBeInTheDocument();
    const testButton = screen.getByRole("button", { name: "Test connection" });
    expect(testButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "nas.example.com" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "monitor" } });
    await waitFor(() => expect(testButton).toBeEnabled());
    fireEvent.click(testButton);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ auth: "key", useGeneratedKey: true, address: "nas.example.com" });
    expect((bodies[0] as Record<string, unknown>).credential).toBeUndefined();
  });
});

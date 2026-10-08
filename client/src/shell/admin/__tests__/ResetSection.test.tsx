import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { apiMocks } from "../../../ui/mocks/api";
import { renderWithApp } from "../../../test-utils";
import { ResetSection } from "../ResetSection";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("ResetSection", () => {
  it("keeps the button off until RESET is typed, and leaves the credentials unticked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({}))
    );
    renderWithApp(<ResetSection onDone={() => {}} />);
    const button = await screen.findByRole("button", { name: "Reset selected" });
    expect(button).toBeDisabled();
    expect(screen.getByLabelText("Generated SSH key")).not.toBeChecked();
    expect(screen.getByLabelText("Built-in admin password")).not.toBeChecked();
    expect(screen.getByLabelText("Settings")).toBeChecked();

    fireEvent.change(screen.getByLabelText("Type RESET to confirm"), { target: { value: "reset" } });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Type RESET to confirm"), { target: { value: "RESET" } });
    expect(button).toBeEnabled();
  });

  it("posts the ticked scopes and shows what was cleared", async () => {
    const fetchMock = vi.fn(async () => json(apiMocks["POST /api/system/reset"]));
    vi.stubGlobal("fetch", fetchMock);
    const onDone = vi.fn();
    renderWithApp(<ResetSection onDone={onDone} />);
    fireEvent.click(await screen.findByLabelText("Hosts"));
    fireEvent.change(screen.getByLabelText("Type RESET to confirm"), { target: { value: "RESET" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset selected" }));

    expect(await screen.findByText("Reset done")).toBeInTheDocument();
    expect(
      screen.getByText(/First-run wizard opens on the next page load|wizard opens on the next page load/i)
    ).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("api/system/reset");
    expect(JSON.parse(String(init.body))).toEqual({
      scopes: ["settings", "links", "checks", "onboarding", "notifications"],
      confirm: "RESET",
    });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});

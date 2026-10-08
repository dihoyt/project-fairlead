import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router";
import { theme } from "../../../theme";
import { GatePage } from "../GatePage";

function renderAt(search: string, navigate: (url: string) => void) {
  return render(
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <MemoryRouter initialEntries={[`/gate${search}`]}>
        <GatePage navigate={navigate} />
      </MemoryRouter>
    </MantineProvider>
  );
}

describe("GatePage", () => {
  it("hands a signed-in browser back to the server's gate", () => {
    const navigate = vi.fn();
    const rd = "https://longhorn.example.test/#/volume";
    renderAt(`?rd=${encodeURIComponent(rd)}`, navigate);
    expect(screen.getByText("Opening longhorn.example.test…")).toBeTruthy();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0]![0]).toMatch(
      /\/auth\/gate\?rd=https%3A%2F%2Flonghorn\.example\.test%2F%23%2Fvolume$/
    );
  });

  it("goes nowhere without an http(s) address", () => {
    const navigate = vi.fn();
    renderAt("?rd=javascript%3Aalert(1)", navigate);
    expect(screen.getByText("This link doesn't say which app to open.")).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });
});

import type { ReactElement } from "react";
import { MantineProvider } from "@mantine/core";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { theme } from "./theme";

export function renderWithApp(ui: ReactElement) {
  return render(
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <MemoryRouter>{ui}</MemoryRouter>
    </MantineProvider>
  );
}

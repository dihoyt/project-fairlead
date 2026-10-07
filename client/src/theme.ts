import { createTheme } from "@mantine/core";

// "Geist Variable" (not "Geist") is the family @fontsource-variable/geist
// declares; the plain name matches no @font-face and falls back silently.
export const theme = createTheme({
  primaryColor: "cyan",
  defaultRadius: "xs",
  fontFamily: '"Geist Variable", sans-serif',
});

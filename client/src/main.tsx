import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@mantine/core/styles.css";
import "@mantine/charts/styles.css";
import App from "./App.tsx";

// Replaced at build time, so a production bundle carries neither the
// branch nor the mock server it would load.
if (import.meta.env.DEV && import.meta.env.VITE_MOCK_API === "1") {
  const { installMockServer } = await import("./shell/mock/mockServer");
  installMockServer();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

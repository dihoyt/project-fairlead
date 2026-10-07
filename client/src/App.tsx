import { MantineProvider } from "@mantine/core";
import { HashRouter } from "react-router";
import { AuthGate } from "./shell/auth/AuthGate";
import { Layout } from "./shell/Layout";
import { theme } from "./theme";

export default function App() {
  // HashRouter: deep links survive a refresh under any path prefix, since
  // the path the server sees never changes.
  return (
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <AuthGate>
        <HashRouter>
          <Layout />
        </HashRouter>
      </AuthGate>
    </MantineProvider>
  );
}

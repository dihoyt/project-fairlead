import { Component, type ErrorInfo, type ReactNode } from "react";
import { Alert, Button, Code, Stack } from "@mantine/core";

interface State {
  error: Error | null;
}

// One page throwing must not blank the whole app: the shell around it
// keeps working, so the user can navigate away. Keyed by route by the
// caller, so moving to another page clears it.
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Alert color="red" title="This page failed to render" maw={760}>
        <Stack gap="xs">
          <Code block fz="xs">
            {this.state.error.message}
          </Code>
          <Button size="xs" variant="default" w="fit-content" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </Stack>
      </Alert>
    );
  }
}

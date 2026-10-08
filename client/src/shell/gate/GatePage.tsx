import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { Alert, Loader, Paper, Stack, Text } from "@mantine/core";
import { pageUrl } from "../../ui/api";

const leave = (url: string) => window.location.assign(url);

function hostOf(rd: string): string | null {
  try {
    const url = new URL(rd);
    return url.protocol === "https:" || url.protocol === "http:" ? url.host : null;
  } catch {
    return null;
  }
}

// Where the sign-in gate sends someone who wasn't signed in yet: the shell
// has them sign in first, then this hands them back to the server's
// /auth/gate, which sends them on to the app.
export function GatePage({ navigate = leave }: { navigate?: (url: string) => void }) {
  const { search } = useLocation();
  const [rd] = useState(() => new URLSearchParams(search).get("rd") ?? "");
  const host = hostOf(rd);

  useEffect(() => {
    if (host) navigate(pageUrl(`auth/gate?rd=${encodeURIComponent(rd)}`));
  }, [host, rd, navigate]);

  return (
    <Paper withBorder p="lg" maw={480} mx="auto" mt="xl">
      {host ? (
        <Stack align="center" gap="sm">
          <Loader size="sm" />
          <Text size="sm">Opening {host}…</Text>
        </Stack>
      ) : (
        <Alert color="red" variant="light">
          This link doesn't say which app to open.
        </Alert>
      )}
    </Paper>
  );
}

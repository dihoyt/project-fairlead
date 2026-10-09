import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Group, Loader, Stack, Text, Title } from "@mantine/core";
import type { InstallSeedView, SeedItemState } from "@contracts/onboarding";
import { apiRequest, useApi } from "../../ui";

const STATE: Record<SeedItemState, { label: string; color: string }> = {
  applied: { label: "Done", color: "green" },
  failed: { label: "Failed", color: "red" },
  skipped: { label: "Skipped", color: "gray" },
  pending: { label: "Waiting", color: "yellow" },
};

// Whether the welcome page has something to show for the install seed.
export const seedNeedsAttention = (view: InstallSeedView): boolean =>
  view.state === "pending" || (view.state === "done" && !view.dismissed);

// "Set up from your file": applies what install.sh --env left for the first
// admin as soon as the page opens, then lists each item's result.
export function SeedSummary() {
  const loaded = useApi("GET /api/onboarding/seed");
  const [view, setView] = useState<InstallSeedView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (loaded.data) setView((prev) => prev ?? loaded.data);
  }, [loaded.data]);

  useEffect(() => {
    if (view?.state !== "pending" || started.current) return;
    started.current = true;
    apiRequest("POST /api/onboarding/seed/apply")
      .then(setView)
      .catch((err: Error) => setError(err.message));
  }, [view]);

  if (!view || !seedNeedsAttention(view)) return null;
  const applying = view.state === "pending" && !error;

  const dismiss = async () => {
    try {
      setView(await apiRequest("POST /api/onboarding/seed/dismiss"));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Card withBorder padding="lg" maw={960} mb="lg" data-seed-summary>
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={4}>Set up from your file</Title>
          {view.state === "done" ? (
            <Button size="xs" variant="subtle" onClick={() => void dismiss()}>
              Dismiss
            </Button>
          ) : null}
        </Group>
        {applying ? (
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm">Applying the settings from the install file…</Text>
          </Group>
        ) : null}
        {error ? <Alert color="red">{error}</Alert> : null}
        <Stack gap="xs">
          {view.items.map((item) => (
            <Group key={item.id} gap="sm" wrap="nowrap" align="flex-start" data-seed-item={item.id}>
              <Badge color={STATE[item.state].color} variant="light" w={80} style={{ flexShrink: 0 }}>
                {STATE[item.state].label}
              </Badge>
              <div>
                <Text size="sm" fw={500}>
                  {item.label}
                </Text>
                <Text size="sm" c="dimmed">
                  {item.detail}
                </Text>
              </div>
            </Group>
          ))}
        </Stack>
      </Stack>
    </Card>
  );
}

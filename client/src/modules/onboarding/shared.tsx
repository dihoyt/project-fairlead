import { useState, type ReactNode } from "react";
import { Alert, Anchor, Button, Group, Stack, Text } from "@mantine/core";
import { Link } from "react-router";
import type { OnboardingStepId } from "@contracts/onboarding";
import { WhatIsThis } from "../../ui/deploy";

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Runs one async action at a time and keeps its error for display.
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(undefined);
    try {
      return await fn();
    } catch (err) {
      setError(errorText(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

export interface StepProps {
  // Marks the step done (true) or skipped (false) and moves on.
  onFinish: (done: boolean) => Promise<void>;
  // Opens another step of the wizard, for a step that depends on it.
  onGoTo?: (step: OnboardingStepId) => void;
}

export function StepFrame({
  what,
  intro,
  children,
  fullPage,
  canFinish = true,
  finishLabel = "Continue",
  onFinish,
  optional = true,
}: StepProps & {
  // The "What is this?" line: the step's subject in one plain sentence for
  // someone who has never run a cluster.
  what?: ReactNode;
  intro: ReactNode;
  children: ReactNode;
  fullPage?: { to: string; label: string };
  canFinish?: boolean;
  finishLabel?: string;
  optional?: boolean;
}) {
  const { busy, error, run } = useAction();
  return (
    <Stack gap="md" maw={960}>
      {what ? <WhatIsThis>{what}</WhatIsThis> : null}
      <Text size="sm">{intro}</Text>
      {children}
      {error ? <Alert color="red">{error}</Alert> : null}
      <Group justify="space-between">
        {fullPage ? (
          <Anchor component={Link} to={fullPage.to} size="sm">
            {fullPage.label}
          </Anchor>
        ) : (
          <span />
        )}
        <Group gap="xs">
          {optional ? (
            <Button variant="subtle" color="gray" loading={busy} onClick={() => void run(() => onFinish(false))}>
              Skip
            </Button>
          ) : null}
          <Button disabled={!canFinish} loading={busy} onClick={() => void run(() => onFinish(true))}>
            {finishLabel}
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}

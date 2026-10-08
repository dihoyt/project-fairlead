import { useState } from "react";
import { Anchor, Stack, Text } from "@mantine/core";

export interface SkippedStep {
  appId: string;
  name: string;
  reason?: string;
}

// Items a rollout leaves alone (already installed, run by a connector, not
// needed for the access mode), folded into one line.
export function SkippedSteps({ steps }: { steps: SkippedStep[] }) {
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  return (
    <Stack gap={2} data-skipped={steps.length}>
      <Text size="xs" c="dimmed">
        {steps.length} already present or not needed.{" "}
        <Anchor component="button" type="button" size="xs" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Show"}
        </Anchor>
      </Text>
      {open
        ? steps.map((step) => (
            <Text key={step.appId} size="xs" c="dimmed" data-skipped-step={step.appId}>
              {step.name}
              {step.reason ? `: ${step.reason}` : ""}
            </Text>
          ))
        : null}
    </Stack>
  );
}

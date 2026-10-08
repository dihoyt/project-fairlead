import { Accordion, Alert, Anchor, Badge, Group, Stack, Text } from "@mantine/core";
import type { BundlePlan } from "@contracts/deploy";
import { DeployPlanView } from "./DeployPlanView";

// The preview of a bundle rollout: every app in install order, what each
// will run, and which are skipped and why.
export function BundlePlanView({ plan, names = {} }: { plan: BundlePlan; names?: Record<string, string> }) {
  const running = plan.steps.filter((step) => !step.skip);
  const blocked = running.filter((step) => step.plan && !step.plan.allowed);
  return (
    <Stack gap="sm" data-plan-allowed={plan.allowed}>
      <Text size="sm">
        Installs {running.length} {running.length === 1 ? "app" : "apps"} in this order
        {plan.steps.length > running.length ? `, skipping ${plan.steps.length - running.length}` : ""}.
      </Text>
      {!plan.allowed ? (
        <Alert color="red" variant="light" title="Can't roll out yet">
          {blocked.length > 0
            ? blocked
                .map((step) => `${names[step.appId] ?? step.appId}: ${step.plan?.blockedBy ?? "not allowed"}`)
                .join(" ")
            : (plan.blockedBy ?? "One of the apps can't be deployed as planned.")}
        </Alert>
      ) : null}
      {plan.disk?.status === "warn" ? (
        <Alert color="yellow" variant="light" title="Low on disk" data-disk="warn">
          {plan.disk.detail}
        </Alert>
      ) : plan.disk && plan.disk.status !== "crit" ? (
        <Text size="xs" c="dimmed" data-disk={plan.disk.status}>
          {plan.disk.detail}
        </Text>
      ) : null}
      <Accordion variant="separated" chevronPosition="left" multiple>
        {plan.steps.map((step, index) => (
          <Accordion.Item key={step.appId} value={step.appId} data-step={step.appId}>
            <Accordion.Control disabled={step.skip || !step.plan}>
              <Group justify="space-between" wrap="nowrap" gap="xs">
                <Group gap="xs" wrap="nowrap">
                  <Text size="sm" c="dimmed" w={20}>
                    {index + 1}.
                  </Text>
                  <Text size="sm" fw={500}>
                    {names[step.appId] ?? step.appId}
                  </Text>
                  {step.skip ? (
                    <Text size="xs" c="dimmed">
                      {step.reason ?? "Skipped"}
                    </Text>
                  ) : step.plan?.url ? (
                    <Anchor
                      size="xs"
                      href={step.plan.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {step.plan.url}
                    </Anchor>
                  ) : null}
                </Group>
                <Group gap={4} wrap="nowrap">
                  {step.plan?.gate?.state === "gated" ? (
                    <Badge color="green" variant="light" radius="xs" data-gate={step.appId}>
                      behind sign-in
                    </Badge>
                  ) : step.plan?.gate?.state === "public" || step.plan?.gate?.state === "open" ? (
                    <Badge
                      color={step.plan.gate.state === "open" ? "red" : "gray"}
                      variant="light"
                      radius="xs"
                      data-gate={step.appId}
                    >
                      public
                    </Badge>
                  ) : null}
                  {step.skip ? (
                    <Badge color="gray" variant="light" radius="xs">
                      skipped
                    </Badge>
                  ) : step.plan && !step.plan.allowed ? (
                    <Badge color="red" variant="light" radius="xs">
                      blocked
                    </Badge>
                  ) : step.plan?.warnings.length ? (
                    <Badge color="yellow" variant="light" radius="xs">
                      {step.plan.warnings.length} {step.plan.warnings.length === 1 ? "warning" : "warnings"}
                    </Badge>
                  ) : null}
                </Group>
              </Group>
            </Accordion.Control>
            {step.plan ? (
              <Accordion.Panel>
                <DeployPlanView plan={step.plan} names={names} />
              </Accordion.Panel>
            ) : null}
          </Accordion.Item>
        ))}
      </Accordion>
    </Stack>
  );
}

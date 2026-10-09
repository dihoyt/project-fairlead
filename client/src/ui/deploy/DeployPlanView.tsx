import { Alert, Anchor, Code, List, Stack, Text, Title } from "@mantine/core";
import type { AppGateState, DeployPlan } from "@contracts/deploy";

const GATE_LINE: Record<AppGateState, string> = {
  gated: "Only people signed in to this console can open it.",
  public: "Anyone with its address can open it.",
  open: "Anyone with its address can open it; see the warning above.",
  tailnet: "Only devices on your tailnet can reach it.",
};

// The preview of what a deploy will run, before anything does.
export function DeployPlanView({ plan, names = {} }: { plan: DeployPlan; names?: Record<string, string> }) {
  return (
    <Stack gap="sm" data-plan-allowed={plan.allowed}>
      {!plan.allowed && plan.blockedBy ? (
        <Alert color="red" variant="light" title="Can't deploy yet">
          {plan.blockedBy}
        </Alert>
      ) : null}
      {plan.missingRequires.length > 0 ? (
        <Alert color="yellow" variant="light" title="Needs another app first">
          {plan.missingRequires.map((id) => names[id] ?? id).join(", ")} must be installed before this one.
        </Alert>
      ) : null}
      {plan.warnings.map((warning) => (
        <Alert key={warning} color="yellow" variant="light" p="xs">
          {warning}
        </Alert>
      ))}
      <Text size="sm">
        Installs <b>{plan.release}</b> {plan.version} into the <b>{plan.namespace}</b> namespace.
        {plan.url ? (
          <>
            {" "}
            It will answer at{" "}
            <Anchor href={plan.url} target="_blank" rel="noreferrer">
              {plan.url}
            </Anchor>
            .
          </>
        ) : null}
      </Text>
      {plan.gate ? (
        <Text size="sm" data-gate-state={plan.gate.state}>
          {GATE_LINE[plan.gate.state]}
          {plan.gate.reason && plan.gate.state !== "open" ? ` ${plan.gate.reason}` : ""}
        </Text>
      ) : null}
      <div>
        <Title order={6} mb={4}>
          Runs
        </Title>
        <Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {plan.commands.join("\n")}
        </Code>
      </div>
      {plan.values.trim() ? (
        <div>
          <Title order={6} mb={4}>
            Values
          </Title>
          <Code block style={{ whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto" }}>
            {plan.values}
          </Code>
        </div>
      ) : null}
      {plan.creates.length > 0 ? (
        <div>
          <Title order={6} mb={4}>
            Creates
          </Title>
          <List size="sm" spacing={2}>
            {plan.creates.map((obj) => (
              <List.Item key={`${obj.kind}/${obj.namespace ?? ""}/${obj.name}`}>
                {obj.kind} {obj.namespace ? `${obj.namespace}/` : ""}
                {obj.name}
              </List.Item>
            ))}
          </List>
        </div>
      ) : null}
      <Text size="xs" c="dimmed">
        A dry run checks all of this against the cluster and changes nothing. Cancelling an install later leaves in
        place whatever it already applied.
      </Text>
    </Stack>
  );
}

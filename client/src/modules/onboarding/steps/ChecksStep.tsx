import { useState } from "react";
import { Alert, Button, Group, SimpleGrid, Stack, Text, TextInput } from "@mantine/core";
import type { CheckResult } from "@contracts/health";
import { CheckList, StatusBadge, apiRequest, useApi } from "../../../ui";
import { StepFrame, useAction, type StepProps } from "../shared";

export function ChecksStep({ onFinish }: StepProps) {
  const checks = useApi("GET /api/checks");
  const [label, setLabel] = useState("");
  const [target, setTarget] = useState("");
  const [result, setResult] = useState<CheckResult>();
  const action = useAction();

  async function add() {
    setResult(undefined);
    const ran = await action.run(async () => {
      const created = await apiRequest("POST /api/checks", {
        body: { label: label.trim() || target.trim(), kind: "http", target: target.trim() },
      });
      return apiRequest("POST /api/checks/:id/run", { params: { id: created.id } });
    });
    if (!ran) return;
    setResult(ran);
    setLabel("");
    setTarget("");
    checks.reload();
  }

  const list = checks.data ?? [];

  return (
    <StepFrame
      onFinish={onFinish}
      intro="An HTTP check on something people use, say your Gitea or a public app. It reports status, latency and certificate expiry, and warns before the certificate runs out."
      fullPage={{ to: "/checks", label: "Checks page (TCP, auth headers, expected status)" }}
      canFinish={list.length > 0}
    >
      {list.length ? (
        <Stack gap={4}>
          {list.map((check) => (
            <Group key={check.id} gap="xs">
              <StatusBadge status={check.last?.status ?? "unknown"} />
              <Text size="sm">
                {check.label} · {check.target}
              </Text>
            </Group>
          ))}
        </Stack>
      ) : null}
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput
          label="URL"
          placeholder="https://git.example.com"
          value={target}
          onChange={(e) => setTarget(e.currentTarget.value)}
        />
        <TextInput label="Name" placeholder="Gitea" value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
      </SimpleGrid>
      {action.error ? <Alert color="red">{action.error}</Alert> : null}
      {result ? <CheckList results={[result]} showRaw="always" /> : null}
      <Group>
        <Button variant="default" loading={action.busy} disabled={!target.trim()} onClick={add}>
          Add and run
        </Button>
      </Group>
    </StepFrame>
  );
}

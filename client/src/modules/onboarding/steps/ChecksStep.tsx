import { useState } from "react";
import { Alert, Button, Checkbox, Group, SimpleGrid, Stack, Text, TextInput, Title } from "@mantine/core";
import type { CheckResult } from "@contracts/health";
import { CheckList, StatusBadge, apiRequest, useApi } from "../../../ui";
import { DiscoveryNote, useDiscovery } from "../discovery";
import { checkProposals } from "../proposals";
import { StepFrame, useAction, type StepProps } from "../shared";

export function ChecksStep({ onFinish }: StepProps) {
  const checks = useApi("GET /api/checks");
  const [label, setLabel] = useState("");
  const [target, setTarget] = useState("");
  const [result, setResult] = useState<CheckResult>();
  const action = useAction();
  const discovery = useDiscovery();
  // Proposals start ticked; this holds the ones someone unticked.
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<CheckResult[]>([]);
  const proposals = checks.data
    ? checkProposals(discovery.report?.ingressHosts ?? [], checks.data, discovery.apps)
    : [];
  const ticked = proposals.filter((p) => !unticked.has(p.host));

  async function addProposed() {
    setAdded([]);
    const results = await action.run(async () => {
      const out: CheckResult[] = [];
      for (const proposal of ticked) {
        const created = await apiRequest("POST /api/checks", {
          body: { label: proposal.label, kind: "http", target: proposal.url },
        });
        out.push(await apiRequest("POST /api/checks/:id/run", { params: { id: created.id } }));
      }
      return out;
    });
    checks.reload();
    if (results) setAdded(results);
  }

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
      what="A check visits a web address every minute or so and tells you when it stops answering or its certificate is about to expire."
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
      {proposals.length ? (
        <Stack gap="xs" data-proposals>
          <Title order={5}>Found in the cluster</Title>
          <Text size="sm" c="dimmed">
            Every site with an Ingress that nothing checks yet. Untick any you don&apos;t want watched.
          </Text>
          {proposals.map((proposal) => (
            <Checkbox
              key={proposal.host}
              label={`${proposal.label} · ${proposal.url}`}
              checked={!unticked.has(proposal.host)}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                setUnticked((prev) => {
                  const next = new Set(prev);
                  if (on) next.delete(proposal.host);
                  else next.add(proposal.host);
                  return next;
                });
              }}
            />
          ))}
          <Group>
            <Button loading={action.busy} disabled={!ticked.length} onClick={() => void addProposed()}>
              Add {ticked.length} {ticked.length === 1 ? "check" : "checks"}
            </Button>
          </Group>
        </Stack>
      ) : null}
      {added.length ? <CheckList results={added} showRaw="always" /> : null}
      <DiscoveryNote discovery={discovery} />
      <Title order={5}>Add one by hand</Title>
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

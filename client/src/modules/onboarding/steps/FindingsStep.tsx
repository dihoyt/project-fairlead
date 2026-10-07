import { Button, Group, SimpleGrid, Text } from "@mantine/core";
import { Link } from "react-router";
import type { Status } from "@contracts/health";
import type { OnboardingState } from "@contracts/onboarding";
import { Tile, useApi, worstStatus } from "../../../ui";
import { StepFrame, type StepProps } from "../shared";

export function FindingsStep({ onFinish, findings }: StepProps & { findings: OnboardingState["findings"] }) {
  const { unhealthyNodes, failingBackups } = findings;
  const caps = useApi("GET /api/k8s/capabilities");
  // The board's per-PVC rating, so both pages agree on severity; ignored,
  // own-data and other informational rows don't count.
  const posture = useApi("GET /api/backups/posture");
  const uncovered = posture.data?.rows.filter((r) => !r.protected && r.status !== "absent");
  const unprotectedPvcs = uncovered?.length ?? findings.unprotectedPvcs;
  const unprotectedStatus: Status = uncovered ? worstStatus(uncovered.map((r) => r.status)) : "crit";
  // The counts read zero without a cluster, which must not look like a clean bill of health.
  const connected = caps.data?.capabilities.some((c) => c.allowed) ?? true;
  const cluster = (count: number, bad: Status, problem: string, fine: string) =>
    connected
      ? { status: count ? bad : ("ok" as Status), summary: count ? problem : fine }
      : { status: "unknown" as Status, summary: "No cluster connection" };
  return (
    <StepFrame
      onFinish={onFinish}
      optional={false}
      finishLabel="Finish"
      intro="Here's what we found on a first look. The board keeps watching from here; this page stays under Setup if you want to come back."
    >
      <SimpleGrid cols={{ base: 1, md: 3 }}>
        <Tile
          title="Unprotected PVCs"
          {...cluster(
            unprotectedPvcs,
            unprotectedStatus,
            `${unprotectedPvcs} no backup covers`,
            "Every PVC is covered"
          )}
          to="/backups"
        />
        <Tile
          title="Node health"
          {...cluster(unhealthyNodes, "crit", `${unhealthyNodes} not Ready`, "All nodes Ready")}
          to="/health/cluster"
        />
        <Tile
          title="Backup runs"
          status={failingBackups ? "crit" : "ok"}
          summary={failingBackups ? `${failingBackups} volumes whose last backup failed` : "No failed backups"}
          to="/backups"
        />
      </SimpleGrid>
      <Group>
        <Text size="sm" c="dimmed">
          The full picture is on the
        </Text>
        <Button component={Link} to="/health" size="compact-sm" variant="light">
          health board
        </Button>
      </Group>
    </StepFrame>
  );
}

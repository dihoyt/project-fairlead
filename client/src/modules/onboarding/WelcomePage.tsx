import { useEffect, useState, type ReactNode } from "react";
import { Alert, Badge, Button, Card, Loader, SimpleGrid, Stack, Stepper, Text, Title } from "@mantine/core";
import { IconAdjustments, IconPackages } from "@tabler/icons-react";
import { useNavigate } from "react-router";
import type { OnboardingState, OnboardingStep, OnboardingStepId } from "@contracts/onboarding";
import { PageHeader } from "../../shell/PageHeader";
import { apiRequest, useApi, useSession } from "../../ui";
import { BundleDoor } from "./BundleDoor";
import type { StepProps } from "./shared";
import { ChecksStep } from "./steps/ChecksStep";
import { ClusterStep } from "./steps/ClusterStep";
import { FindingsStep } from "./steps/FindingsStep";
import { HostsStep } from "./steps/HostsStep";
import { LinksStep } from "./steps/LinksStep";
import { NotificationsStep } from "./steps/NotificationsStep";
import { OidcStep } from "./steps/OidcStep";
import { PublicUrlField } from "./steps/PublicUrlField";
import { RemoteAccess } from "./steps/RemoteAccess";
import { WhatIsThis } from "../../ui/deploy";

const TITLES: Record<OnboardingStepId, { label: string; description: string }> = {
  password: { label: "Password", description: "Admin password changed" },
  cluster: { label: "Cluster", description: "Connection and permissions" },
  access: { label: "Access", description: "How you reach your apps" },
  oidc: { label: "Sign-in", description: "Your identity provider" },
  links: { label: "Links", description: "Rancher, Headlamp, …" },
  hosts: { label: "Hosts", description: "NAS and servers over SSH" },
  checks: { label: "Checks", description: "A first HTTP check" },
  notifications: { label: "Alerts", description: "Where changes are sent" },
  findings: { label: "Findings", description: "What we found" },
};

const settled = (step: OnboardingStep) => step.done || step.skipped;

type Door = "bundle" | "custom";

// A fresh install (nothing settled past the password) starts at the two doors.
export function startsAtDoors(steps: OnboardingStep[]): boolean {
  return !steps.some((step) => step.id !== "password" && settled(step));
}

function Doors({ onPick }: { onPick: (door: Door) => void }) {
  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }} maw={960} data-doors>
      <Card withBorder padding="lg">
        <Stack gap="sm" h="100%">
          <IconPackages size={28} stroke={1.5} />
          <Title order={4}>Deploy bundle</Title>
          <Text size="sm" c="dimmed" style={{ flex: 1 }}>
            Answer a few questions and get a complete self-hosted setup: ingress, certificates, metrics, sign-in
            (Authentik), Git (Gitea), dashboards (Grafana, Headlamp), storage and push alerts (ntfy), with links and
            checks wired up. Anything already in the cluster is left alone, and you see the full plan before anything
            runs.
          </Text>
          <Button onClick={() => onPick("bundle")}>Deploy bundle</Button>
        </Stack>
      </Card>
      <Card withBorder padding="lg">
        <Stack gap="sm" h="100%">
          <IconAdjustments size={28} stroke={1.5} />
          <Title order={4}>Custom setup</Title>
          <Text size="sm" c="dimmed" style={{ flex: 1 }}>
            Go step by step: see what is already running, connect the tools you have, and deploy only the pieces you
            pick.
          </Text>
          <Button variant="default" onClick={() => onPick("custom")}>
            Custom setup
          </Button>
        </Stack>
      </Card>
    </SimpleGrid>
  );
}

// The first step still to do, else the last one.
export function firstOpenStep(steps: OnboardingStep[]): number {
  const index = steps.findIndex((step) => !settled(step));
  return index === -1 ? steps.length - 1 : index;
}

export function WelcomePage() {
  const { me } = useSession();
  const navigate = useNavigate();
  const state = useApi("GET /api/onboarding/state", undefined, { enabled: me.admin });
  const [current, setCurrent] = useState<OnboardingState | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [door, setDoor] = useState<Door | null>(null);

  useEffect(() => {
    if (!state.data) return;
    setCurrent(state.data);
    setActive((prev) => prev ?? firstOpenStep(state.data!.steps));
    setDoor((prev) => prev ?? (startsAtDoors(state.data!.steps) ? null : "custom"));
  }, [state.data]);

  if (!me.admin) return <Alert color="yellow">First-run setup is for admins.</Alert>;
  if (state.error && !current) return <Alert color="red">{state.error}</Alert>;
  if (!current || active === null) return <Loader size="sm" />;

  const steps = current.steps;

  const finish = (id: OnboardingStepId) => async (done: boolean) => {
    const next = await apiRequest("POST /api/onboarding/steps/:step", {
      params: { step: id },
      body: { action: done ? "done" : "skip" },
    });
    setCurrent(next);
    if (id === "findings") {
      navigate("/health");
      return;
    }
    const index = steps.findIndex((s) => s.id === id);
    setActive(Math.min(index + 1, steps.length - 1));
  };

  const panel = (step: OnboardingStep): ReactNode => {
    const props: StepProps = { onFinish: finish(step.id) };
    switch (step.id) {
      case "password":
        return (
          <Stack gap="md" maw={960}>
            <WhatIsThis>
              The public URL is the address people type to reach this page; sign-in links and alerts point back to it.
            </WhatIsThis>
            <Text size="sm">
              Your password is changed. Check the public URL below, then carry on with the next step.
            </Text>
            <PublicUrlField />
            <RemoteAccess />
          </Stack>
        );
      case "cluster":
        return <ClusterStep {...props} />;
      case "access":
        return <RemoteAccess />;
      case "oidc":
        return <OidcStep {...props} />;
      case "links":
        return <LinksStep {...props} />;
      case "hosts":
        return (
          <Stack gap="md">
            <WhatIsThis>
              Hosts are machines outside Kubernetes, like a NAS or a backup server, that this app logs in to over SSH to
              read disk space and load.
            </WhatIsThis>
            <HostsStep {...props} />
          </Stack>
        );
      case "checks":
        return <ChecksStep {...props} />;
      case "notifications":
        return <NotificationsStep {...props} />;
      case "findings":
        return <FindingsStep {...props} findings={current.findings} />;
    }
  };

  return (
    <>
      <PageHeader
        title="Setup"
        description="Every step but the last can be skipped and done later; this page stays under Setup in the sidebar."
        actions={
          <>
            {door === "custom" ? (
              <Button size="xs" variant="subtle" onClick={() => setDoor("bundle")}>
                Deploy bundle
              </Button>
            ) : door === "bundle" ? (
              <Button size="xs" variant="subtle" onClick={() => setDoor("custom")}>
                Custom setup
              </Button>
            ) : null}
            {current.complete ? <Badge color="green">Complete</Badge> : null}
          </>
        }
      />
      {door === null ? <Doors onPick={setDoor} /> : null}
      {door === "bundle" ? <BundleDoor onDone={() => setDoor("custom")} /> : null}
      {door === "custom" ? (
        <Stepper active={active} onStepClick={setActive} size="sm" allowNextStepsSelect>
          {steps.map((step, index) => (
            <Stepper.Step
              key={step.id}
              label={TITLES[step.id].label}
              description={step.skipped ? "Skipped" : TITLES[step.id].description}
              // Mantine draws every step before `active` as complete; a step still
              // to do keeps its number there instead of a check.
              completedIcon={step.skipped ? "–" : step.done ? undefined : index + 1}
              color={settled(step) && !step.skipped ? undefined : "gray"}
            >
              {panel(step)}
            </Stepper.Step>
          ))}
        </Stepper>
      ) : null}
    </>
  );
}

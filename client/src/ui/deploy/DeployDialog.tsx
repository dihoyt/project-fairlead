import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Checkbox, Group, List, Loader, Modal, Stack, Text, Title } from "@mantine/core";
import type { CatalogAppView } from "@contracts/catalog";
import type { DeployJobView, DeployMode, DeployPlan, DeployStatus, DeployValue } from "@contracts/deploy";
import { apiRequest } from "../api";
import type { DeployResult } from "../contracts";
import { DeployInputsForm } from "./DeployInputsForm";
import { DeployJobProgress } from "./DeployJobProgress";
import { DeployPlanView } from "./DeployPlanView";
import { DeploysOff } from "./DeploysOff";
import { MASKED } from "./jobs";
import { WhatIsThis } from "./WhatIsThis";

export interface DeployDialogProps {
  appId: string;
  opened: boolean;
  onClose: () => void;
  initial?: Record<string, DeployValue>;
  onDeployed?: (result: DeployResult) => void;
}

type Step =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "off"; status: DeployStatus }
  | { kind: "form" }
  | { kind: "preview"; plan: DeployPlan; dryRunId?: string }
  | { kind: "install"; jobId: string };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Empty optional fields are left out so the server's derived default applies.
function requestInputs(values: Record<string, DeployValue>): Record<string, DeployValue> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
}

function startingValues(
  app: CatalogAppView,
  plan: DeployPlan | null,
  initial: Record<string, DeployValue> | undefined
): Record<string, DeployValue> {
  const values: Record<string, DeployValue> = {};
  for (const input of app.inputs) {
    const fromPlan = plan?.inputs[input.key];
    const preset = initial?.[input.key];
    if (preset !== undefined) values[input.key] = preset;
    else if (fromPlan !== undefined && fromPlan !== MASKED) values[input.key] = fromPlan;
    else if (input.default !== undefined) values[input.key] = input.default;
    else values[input.key] = input.kind === "boolean" ? false : "";
  }
  return values;
}

// The whole deploy flow for one catalog app: inputs, the plan preview, an
// optional dry run, then the install with its live log. Secret values live
// only in this dialog's state and are dropped when it closes.
export function DeployDialog({ appId, opened, onClose, initial, onDeployed }: DeployDialogProps) {
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [app, setApp] = useState<CatalogAppView | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [values, setValues] = useState<Record<string, DeployValue>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"plan" | DeployMode | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isPublic, setPublic] = useState(false);
  const initialKey = JSON.stringify(initial ?? {});

  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    const preset = JSON.parse(initialKey) as Record<string, DeployValue>;
    setStep({ kind: "loading" });
    setErrors({});
    setActionError(null);
    void (async () => {
      try {
        const [status, view] = await Promise.all([
          apiRequest("GET /api/deploy/status"),
          apiRequest("GET /api/catalog/apps/:id", { params: { id: appId } }),
        ]);
        if (cancelled) return;
        setApp(view);
        if (!status.enabled) {
          setStep({ kind: "off", status });
          return;
        }
        // A first plan fills in the defaults the server derives (the host
        // under the base domain); its errors wait until the user previews.
        const plan = await apiRequest("POST /api/deploy/plan", { body: { appId, inputs: requestInputs(preset) } });
        if (cancelled) return;
        const apps = await apiRequest("GET /api/catalog/apps").catch(() => []);
        if (cancelled) return;
        setNames(Object.fromEntries(apps.map((a) => [a.id, a.name])));
        setValues(startingValues(view, plan, preset));
        setStep(view.inputs.length === 0 ? { kind: "preview", plan } : { kind: "form" });
      } catch (err) {
        if (!cancelled) setStep({ kind: "error", message: message(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [opened, appId, initialKey]);

  const close = useCallback(() => {
    setValues({});
    setPublic(false);
    onClose();
  }, [onClose]);

  async function preview(makePublic = isPublic) {
    setBusy("plan");
    setActionError(null);
    try {
      const plan = await apiRequest("POST /api/deploy/plan", {
        body: { appId, inputs: requestInputs(values), public: makePublic },
      });
      setErrors(plan.inputErrors);
      if (Object.keys(plan.inputErrors).length === 0) setStep({ kind: "preview", plan });
    } catch (err) {
      setActionError(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function start(mode: DeployMode, plan: DeployPlan) {
    setBusy(mode);
    setActionError(null);
    try {
      const job = await apiRequest("POST /api/deploy/jobs", {
        body: { appId, namespace: plan.namespace, inputs: requestInputs(values), mode, public: isPublic },
      });
      setStep(mode === "install" ? { kind: "install", jobId: job.id } : { kind: "preview", plan, dryRunId: job.id });
    } catch (err) {
      setActionError(message(err));
    } finally {
      setBusy(null);
    }
  }

  const finished = useCallback(
    (job: DeployJobView) => {
      if (job.mode === "install" && job.state === "succeeded") {
        setValues({});
        onDeployed?.({ appId: job.appId, jobId: job.id, url: job.url });
      }
    },
    [onDeployed]
  );

  const title = app ? `Deploy ${app.name}` : "Deploy";

  return (
    <Modal opened={opened} onClose={close} title={title} size="lg">
      <Stack gap="md">
        {app && step.kind !== "loading" ? (
          <Stack gap={6}>
            <WhatIsThis>{app.summary}</WhatIsThis>
            {app.prerequisites.length > 0 && step.kind !== "install" ? (
              <Alert color="blue" variant="light" p="xs" title="Before you start">
                <List size="sm" spacing={2}>
                  {app.prerequisites.map((p) => (
                    <List.Item key={p}>{p}</List.Item>
                  ))}
                </List>
              </Alert>
            ) : null}
          </Stack>
        ) : null}

        {step.kind === "loading" ? (
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm" c="dimmed">
              Getting ready…
            </Text>
          </Group>
        ) : null}

        {step.kind === "error" ? (
          <Alert color="red" variant="light">
            {step.message}
          </Alert>
        ) : null}

        {step.kind === "off" ? <DeploysOff status={step.status} /> : null}

        {step.kind === "form" && app ? (
          <DeployInputsForm
            inputs={app.inputs}
            values={values}
            errors={errors}
            disabled={busy !== null}
            onChange={(key, value) => setValues((prev) => ({ ...prev, [key]: value }))}
          />
        ) : null}

        {step.kind === "preview" ? (
          <>
            {app &&
            app.gate !== "public" &&
            (step.plan.gate?.state === "gated" || step.plan.gate?.state === "public") ? (
              <Checkbox
                label="Public"
                description="Anyone with its address can open it, without signing in to this console first."
                checked={isPublic}
                disabled={busy !== null}
                onChange={(event) => {
                  const next = event.currentTarget.checked;
                  setPublic(next);
                  void preview(next);
                }}
              />
            ) : null}
            <DeployPlanView plan={step.plan} names={names} />
            {step.dryRunId ? (
              <div>
                <Title order={6} mb={4}>
                  Dry run
                </Title>
                <DeployJobProgress key={step.dryRunId} jobId={step.dryRunId} />
              </div>
            ) : null}
          </>
        ) : null}

        {step.kind === "install" ? <DeployJobProgress jobId={step.jobId} onFinished={finished} /> : null}

        {actionError ? (
          <Alert color="red" variant="light" p="xs">
            {actionError}
          </Alert>
        ) : null}

        <Group justify="flex-end" gap="xs">
          {step.kind === "form" ? (
            <>
              <Button variant="default" onClick={close}>
                Cancel
              </Button>
              <Button loading={busy === "plan"} onClick={() => void preview()}>
                Preview
              </Button>
            </>
          ) : null}
          {step.kind === "preview" ? (
            <>
              {app && app.inputs.length > 0 ? (
                <Button variant="default" disabled={busy !== null} onClick={() => setStep({ kind: "form" })}>
                  Back
                </Button>
              ) : null}
              <Button
                variant="light"
                disabled={!step.plan.allowed || (busy !== null && busy !== "dry-run")}
                loading={busy === "dry-run"}
                onClick={() => void start("dry-run", step.plan)}
              >
                Dry run
              </Button>
              <Button
                disabled={!step.plan.allowed || (busy !== null && busy !== "install")}
                loading={busy === "install"}
                onClick={() => void start("install", step.plan)}
              >
                Install
              </Button>
            </>
          ) : null}
          {step.kind === "install" || step.kind === "off" || step.kind === "error" ? (
            <Button variant="default" onClick={close}>
              Close
            </Button>
          ) : null}
        </Group>
      </Stack>
    </Modal>
  );
}

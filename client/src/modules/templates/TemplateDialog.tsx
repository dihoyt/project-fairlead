import { useCallback, useState } from "react";
import {
  ActionIcon,
  Alert,
  Button,
  Code,
  Group,
  List,
  Modal,
  NumberInput,
  ScrollArea,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import type { DeployJobView, DeployMode } from "@contracts/deploy";
import { CUSTOM_TEMPLATE, type AppTemplate, type TemplatePlan } from "@contracts/templates";
import { apiRequest } from "../../ui";
import { DeployJobProgress, DeployPlanView, WhatIsThis } from "../../ui/deploy";
import { addCheck, toRequest, type TemplateForm } from "./request";

type Step =
  { kind: "form" } | { kind: "preview"; plan: TemplatePlan; dryRunId?: string } | { kind: "install"; jobId: string };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface TemplateDialogProps {
  template: AppTemplate;
  initial: TemplateForm;
  baseDomain?: string;
  defaultStorageClass?: string;
  onClose: () => void;
  onDeployed: () => void;
}

// One template from form to running app: the fields, the rendered manifests
// and the runner's plan, an optional dry run, then the install with its log.
export function TemplateDialog({
  template,
  initial,
  baseDomain,
  defaultStorageClass,
  onClose,
  onDeployed,
}: TemplateDialogProps) {
  const custom = template.id === CUSTOM_TEMPLATE;
  const [form, setForm] = useState<TemplateForm>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [busy, setBusy] = useState<"plan" | DeployMode | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const set = <K extends keyof TemplateForm>(key: K, value: TemplateForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));
  const keepsData = custom ? form.volume : Boolean(template.volume);
  const defaultHost = form.name.trim() && baseDomain ? `${form.name.trim()}.${baseDomain}` : undefined;

  async function preview() {
    setBusy("plan");
    setActionError(null);
    try {
      const plan = await apiRequest("POST /api/templates/plan", { body: toRequest(template, form) });
      setErrors(plan.fieldErrors);
      if (Object.keys(plan.fieldErrors).length === 0) setStep({ kind: "preview", plan });
    } catch (err) {
      setActionError(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function start(mode: DeployMode, plan: TemplatePlan) {
    setBusy(mode);
    setActionError(null);
    try {
      const job = await apiRequest("POST /api/templates/jobs", { body: { ...toRequest(template, form), mode } });
      setStep(mode === "install" ? { kind: "install", jobId: job.id } : { kind: "preview", plan, dryRunId: job.id });
      if (mode === "install") onDeployed();
    } catch (err) {
      setActionError(message(err));
    } finally {
      setBusy(null);
    }
  }

  const finished = useCallback(
    (job: DeployJobView) => {
      if (job.mode !== "install") return;
      onDeployed();
      if (job.state !== "succeeded" || !job.url) return;
      addCheck(job.appId, job.url).then(
        (added) => setNote(added ? `Added an HTTP check for ${job.url}.` : null),
        (err: unknown) => setNote(`Could not add an HTTP check: ${message(err)}`)
      );
    },
    [onDeployed]
  );

  const field = (key: string) => errors[key];

  return (
    <Modal opened onClose={onClose} title={`Deploy ${template.name}`} size="lg">
      <Stack gap="md">
        <WhatIsThis>{template.summary}</WhatIsThis>

        {step.kind === "form" ? (
          <Stack gap="sm">
            <TextInput
              label="Name"
              description="Its namespace and the first part of its hostname."
              value={form.name}
              error={field("name")}
              onChange={(e) => set("name", e.currentTarget.value)}
            />
            {custom ? (
              <>
                <TextInput
                  label="Image"
                  description="With a tag or digest, like ghcr.io/org/app:1.2.3."
                  value={form.image}
                  error={field("custom.image")}
                  onChange={(e) => set("image", e.currentTarget.value)}
                />
                <NumberInput
                  label="Port"
                  description="The container port its web page or API listens on."
                  value={form.port === "" ? "" : Number(form.port)}
                  min={1}
                  max={65535}
                  allowDecimal={false}
                  error={field("custom.port")}
                  onChange={(value) => set("port", value === "" ? "" : String(value))}
                />
                <Stack gap={4}>
                  <Text size="sm" fw={500}>
                    Environment variables
                  </Text>
                  <Text size="xs" c="dimmed">
                    Stored and shown in plain text: don't put passwords here.
                  </Text>
                  {form.env.map((env, i) => (
                    <Group key={i} gap="xs" align="flex-start" wrap="nowrap">
                      <TextInput
                        aria-label={`Variable ${i + 1} name`}
                        placeholder="NAME"
                        value={env.name}
                        error={field(`custom.env.${i}.name`)}
                        style={{ flex: 1 }}
                        onChange={(e) => {
                          const value = e.currentTarget.value;
                          set(
                            "env",
                            form.env.map((x, j) => (j === i ? { ...x, name: value } : x))
                          );
                        }}
                      />
                      <TextInput
                        aria-label={`Variable ${i + 1} value`}
                        placeholder="value"
                        value={env.value}
                        error={field(`custom.env.${i}.value`)}
                        style={{ flex: 2 }}
                        onChange={(e) => {
                          const value = e.currentTarget.value;
                          set(
                            "env",
                            form.env.map((x, j) => (j === i ? { ...x, value } : x))
                          );
                        }}
                      />
                      <ActionIcon
                        variant="subtle"
                        mt={6}
                        aria-label={`Remove variable ${i + 1}`}
                        onClick={() =>
                          set(
                            "env",
                            form.env.filter((_, j) => j !== i)
                          )
                        }
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Group>
                  ))}
                  <Group>
                    <Button
                      size="xs"
                      variant="subtle"
                      leftSection={<IconPlus size={14} />}
                      onClick={() => set("env", [...form.env, { name: "", value: "" }])}
                    >
                      Add variable
                    </Button>
                  </Group>
                  {field("custom.env") ? (
                    <Text size="xs" c="red">
                      {field("custom.env")}
                    </Text>
                  ) : null}
                </Stack>
                <Switch
                  label="Keep data on a volume"
                  checked={form.volume}
                  onChange={(e) => set("volume", e.currentTarget.checked)}
                />
                {form.volume ? (
                  <TextInput
                    label="Mount path"
                    value={form.mountPath}
                    error={field("custom.volume.mountPath")}
                    onChange={(e) => set("mountPath", e.currentTarget.value)}
                  />
                ) : null}
              </>
            ) : null}
            {keepsData ? (
              <Group grow align="flex-start">
                <TextInput
                  label="Volume size"
                  placeholder={template.volume?.size ?? "1Gi"}
                  value={form.volumeSize}
                  error={field("volumeSize") ?? field("custom.volume.size")}
                  onChange={(e) => set("volumeSize", e.currentTarget.value)}
                />
                <TextInput
                  label="Storage class"
                  placeholder={defaultStorageClass ? `${defaultStorageClass} (default)` : "the cluster's default"}
                  value={form.storageClass}
                  error={field("storageClass")}
                  onChange={(e) => set("storageClass", e.currentTarget.value)}
                />
              </Group>
            ) : null}
            <Switch
              label="Reachable at a hostname"
              description="Off: reachable inside the cluster only."
              checked={form.exposed}
              onChange={(e) => set("exposed", e.currentTarget.checked)}
            />
            {form.exposed ? (
              <TextInput
                label="Hostname"
                placeholder={defaultHost ?? "app.example.com"}
                description={defaultHost ? `Leave empty for ${defaultHost}.` : undefined}
                value={form.host}
                error={field("host")}
                onChange={(e) => set("host", e.currentTarget.value)}
              />
            ) : null}
          </Stack>
        ) : null}

        {step.kind === "preview" ? (
          <Stack gap="sm">
            {step.plan.violations.length > 0 ? (
              <Alert color="red" variant="light" title="Refused by the guardrail">
                <List size="sm" spacing={2}>
                  {step.plan.violations.map((v) => (
                    <List.Item key={`${v.object}:${v.path}`}>
                      {v.object}: {v.message} <Code>{v.path}</Code>
                    </List.Item>
                  ))}
                </List>
              </Alert>
            ) : null}
            {step.plan.deploy ? <DeployPlanView plan={step.plan.deploy} /> : null}
            {!step.plan.allowed && step.plan.blockedBy && step.plan.violations.length === 0 ? (
              <Alert color="orange" variant="light" p="xs">
                {step.plan.blockedBy}
              </Alert>
            ) : null}
            <div>
              <Title order={6} mb={4}>
                Manifests
              </Title>
              <ScrollArea.Autosize mah={280}>
                <Code block data-testid="manifests">
                  {step.plan.manifests}
                </Code>
              </ScrollArea.Autosize>
            </div>
            {step.dryRunId ? (
              <div>
                <Title order={6} mb={4}>
                  Dry run
                </Title>
                <DeployJobProgress key={step.dryRunId} jobId={step.dryRunId} />
              </div>
            ) : null}
          </Stack>
        ) : null}

        {step.kind === "install" ? <DeployJobProgress jobId={step.jobId} onFinished={finished} /> : null}

        {note ? (
          <Text size="sm" c="dimmed">
            {note}
          </Text>
        ) : null}
        {actionError ? (
          <Alert color="red" variant="light" p="xs">
            {actionError}
          </Alert>
        ) : null}

        <Group justify="flex-end" gap="xs">
          {step.kind === "form" ? (
            <>
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button loading={busy === "plan"} onClick={() => void preview()}>
                Preview
              </Button>
            </>
          ) : null}
          {step.kind === "preview" ? (
            <>
              <Button variant="default" disabled={busy !== null} onClick={() => setStep({ kind: "form" })}>
                Back
              </Button>
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
                Deploy
              </Button>
            </>
          ) : null}
          {step.kind === "install" ? (
            <Button variant="default" onClick={onClose}>
              Close
            </Button>
          ) : null}
        </Group>
      </Stack>
    </Modal>
  );
}

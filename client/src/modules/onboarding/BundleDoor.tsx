import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Group, Loader, Paper, Stack, Text, Title } from "@mantine/core";
import type { CatalogBundleView } from "@contracts/catalog";
import type { BundlePlan, BundleRunView, DeployValue } from "@contracts/deploy";
import { apiRequest, useApi } from "../../ui";
import { BundlePlanView, DeployInputsForm, DeployRolloutProgress, DeploysOff, WhatIsThis } from "../../ui/deploy";
import { landedSteps, wireLanded } from "./bundle";
import { useDiscovery } from "./discovery";
import { useAction } from "./shared";
import { PublicUrlField } from "./steps/PublicUrlField";

const RUN_POLL_MS = 3_000;

// The bundle's shared answers, prefilled from discovery's suggestions.
export function initialBundleValues(bundle: CatalogBundleView): Record<string, DeployValue> {
  const values: Record<string, DeployValue> = {};
  for (const input of bundle.inputs) {
    const suggested = bundle.suggested[input.key as keyof CatalogBundleView["suggested"]];
    const value = suggested ?? input.default;
    if (value !== undefined) values[input.key] = value;
  }
  return values;
}

// Optional items to roll out: the ones the bundle view starts ticked.
export function initialInclude(bundle: CatalogBundleView): string[] {
  return bundle.items.filter((item) => !item.required && !item.skip && item.selected).map((item) => item.appId);
}

export function BundleDoor({ onDone }: { onDone: () => void }) {
  const bundles = useApi("GET /api/catalog/bundles");
  const runs = useApi("GET /api/deploy/bundles");
  const status = useApi("GET /api/deploy/status");
  const discovery = useDiscovery();
  const bundle = bundles.data?.[0];
  const [values, setValues] = useState<Record<string, DeployValue>>({});
  const [include, setInclude] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [plan, setPlan] = useState<BundlePlan>();
  const [runId, setRunId] = useState<string>();
  const action = useAction();

  useEffect(() => {
    if (!bundle || ready) return;
    setValues(initialBundleValues(bundle));
    setInclude(initialInclude(bundle));
    setReady(true);
  }, [bundle, ready]);

  // Reopening the page while a rollout runs goes straight back to it.
  const active = runs.data?.find((run) => run.state === "running");
  const shownRun = runId ?? active?.id;

  if (bundles.error) return <Alert color="red">{bundles.error}</Alert>;
  if (!bundle || !ready) return <Loader size="sm" />;
  const names = Object.fromEntries((discovery.apps ?? []).map((app) => [app.id, app.name]));
  const name = (appId: string) => names[appId] ?? appId;

  if (shownRun) return <BundleRun runId={shownRun} names={names} onDone={onDone} />;

  const request = () => ({ bundleId: bundle.id, inputs: values, include });

  async function preview() {
    const next = await action.run(() => apiRequest("POST /api/deploy/bundles/plan", { body: request() }));
    if (next) setPlan(next);
  }

  async function start() {
    const run = await action.run(() => apiRequest("POST /api/deploy/bundles", { body: request() }));
    if (run) setRunId(run.id);
  }

  const off = status.data ? !status.data.enabled : false;
  const missingRequired = bundle.inputs.some(
    (input) => input.required && (values[input.key] === undefined || values[input.key] === "")
  );

  if (plan) {
    return (
      <Stack gap="md" maw={960} data-bundle-preview>
        <Text size="sm">
          This is everything the rollout will run, in order. Nothing has run yet; each app installs only after the one
          before it succeeds, and the rollout stops at the first failure.
        </Text>
        {off ? <DeploysOff status={status.data!} /> : null}
        <BundlePlanView plan={plan} names={names} />
        {action.error ? <Alert color="red">{action.error}</Alert> : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setPlan(undefined)}>
            Back
          </Button>
          <Button loading={action.busy} disabled={!plan.allowed || off} onClick={() => void start()}>
            Start rollout
          </Button>
        </Group>
      </Stack>
    );
  }

  return (
    <Stack gap="md" maw={960} data-bundle-form>
      <WhatIsThis>{bundle.summary}</WhatIsThis>
      {off ? <DeploysOff status={status.data!} /> : null}
      <PublicUrlField />
      <DeployInputsForm
        inputs={bundle.inputs}
        values={values}
        onChange={(key, value) => setValues((prev) => ({ ...prev, [key]: value }))}
      />
      <Stack gap={6}>
        <Title order={5}>What it rolls out</Title>
        {bundle.items.map((item) => (
          <Paper key={item.appId} withBorder p="xs" data-item={item.appId}>
            <Checkbox
              label={name(item.appId)}
              description={item.skip || !item.selected ? item.reason : item.note}
              checked={!item.skip && (item.required || include.includes(item.appId))}
              disabled={item.skip || item.required}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                setInclude((prev) => (on ? [...prev, item.appId] : prev.filter((id) => id !== item.appId)));
              }}
            />
          </Paper>
        ))}
      </Stack>
      {action.error ? <Alert color="red">{action.error}</Alert> : null}
      <Group justify="flex-end">
        <Button loading={action.busy} disabled={missingRequired} onClick={() => void preview()}>
          Preview
        </Button>
      </Group>
    </Stack>
  );
}

function BundleRun({ runId, names, onDone }: { runId: string; names: Record<string, string>; onDone: () => void }) {
  const [finished, setFinished] = useState(false);
  const run = useApi(
    "GET /api/deploy/bundles/:id",
    { params: { id: runId } },
    { pollMs: finished ? undefined : RUN_POLL_MS }
  );
  const discovery = useDiscovery();
  const wired = useRef(new Set<string>());
  const [wireError, setWireError] = useState<string>();
  const data: BundleRunView | null = run.data;

  // Each app that lands gets its link and check once, as soon as it lands.
  useEffect(() => {
    if (!data || !discovery.apps) return;
    const fresh = landedSteps(data).filter((l) => !wired.current.has(l.appId));
    if (!fresh.length) return;
    for (const l of fresh) wired.current.add(l.appId);
    wireLanded(fresh, discovery.apps).catch((err: unknown) =>
      setWireError(err instanceof Error ? err.message : String(err))
    );
  }, [data, discovery.apps]);

  useEffect(() => {
    if (data && data.state !== "running") setFinished(true);
  }, [data]);

  if (!data) return run.error ? <Alert color="red">{run.error}</Alert> : <Loader size="sm" />;
  return (
    <Stack gap="md" maw={960} data-bundle-run={data.state}>
      <DeployRolloutProgress runId={runId} names={names} />
      {wireError ? <Alert color="yellow">Could not add a link or check for a deployed app: {wireError}</Alert> : null}
      {data.state === "succeeded" ? (
        <Alert color="green" title="Rolled out">
          Links and HTTP checks are set up for each app with a web page. Carry on with the remaining setup steps.
        </Alert>
      ) : null}
      {data.state === "failed" ? (
        <Alert color="red" title="Stopped">
          The rollout stopped at the first failure; what installed before it stays. Fix the cause from the log and open
          the bundle again from Setup; it skips whatever is already installed.
        </Alert>
      ) : null}
      <Group justify="flex-end">
        <Button disabled={data.state === "running"} onClick={onDone}>
          Continue setup
        </Button>
      </Group>
    </Stack>
  );
}

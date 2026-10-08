import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Group, Loader, Paper, SegmentedControl, Stack, Text, Title } from "@mantine/core";
import type { CatalogBundleView } from "@contracts/catalog";
import type { AccessView, BundlePlan, BundleRunView, DeployValue } from "@contracts/deploy";
import { apiRequest, useApi } from "../../ui";
import { BundlePlanView, DeployInputsForm, DeployRolloutProgress, DeploysOff, WhatIsThis } from "../../ui/deploy";
import { CloudflarePanel } from "../connector-cloudflare/CloudflarePage";
import { holds, landedSteps, runFailures, wireLanded } from "./bundle";
import { AccessInstructions } from "./steps/AccessStep";
import { useDiscovery } from "./discovery";
import { useAction } from "./shared";
import { PublicUrlField } from "./steps/PublicUrlField";

const RUN_POLL_MS = 3_000;

// The bundle input choosing how Cloudflare Tunnel is set up. Its catalog
// default is the pasted token, for API callers that predate it; here it
// starts on the connector.
export const CLOUDFLARE_SETUP = "cloudflareSetup";

// The bundle's shared answers, prefilled from discovery's suggestions.
export function initialBundleValues(bundle: CatalogBundleView): Record<string, DeployValue> {
  const values: Record<string, DeployValue> = {};
  for (const input of bundle.inputs) {
    const suggested = bundle.suggested[input.key as keyof CatalogBundleView["suggested"]];
    const value = suggested ?? input.default;
    if (value !== undefined) values[input.key] = value;
  }
  if (bundle.inputs.some((input) => input.key === CLOUDFLARE_SETUP)) values[CLOUDFLARE_SETUP] = "api";
  return values;
}

const STORAGE_CLASS = "storageClass";
// The class Longhorn's chart creates.
const LONGHORN_CLASS = "longhorn";

// What the storage class field holds until the user types in it: Longhorn's
// while Longhorn is in the rollout, else discovery's suggestion.
export function defaultStorageClass(bundle: CatalogBundleView, include: string[]): string {
  if (include.includes("longhorn")) return LONGHORN_CLASS;
  const input = bundle.inputs.find((i) => i.key === STORAGE_CLASS);
  const fallback = bundle.suggested.storageClass ?? input?.default;
  return typeof fallback === "string" ? fallback : "";
}

// The form's answers survive leaving the page, for this browser session.
// Secret inputs are never written.
interface BundleDraft {
  values: Record<string, DeployValue>;
  include: string[];
  storageTyped: boolean;
}
const draftKey = (bundle: CatalogBundleView) => `bundle-draft:${bundle.id}`;

export function loadDraft(bundle: CatalogBundleView): BundleDraft | undefined {
  try {
    const raw = sessionStorage.getItem(draftKey(bundle));
    return raw ? (JSON.parse(raw) as BundleDraft) : undefined;
  } catch {
    return undefined;
  }
}

function saveDraft(bundle: CatalogBundleView, draft: BundleDraft | undefined) {
  try {
    if (!draft) {
      sessionStorage.removeItem(draftKey(bundle));
      return;
    }
    const secret = new Set(bundle.inputs.filter((i) => i.kind === "secret").map((i) => i.key));
    const values = Object.fromEntries(Object.entries(draft.values).filter(([key]) => !secret.has(key)));
    sessionStorage.setItem(draftKey(bundle), JSON.stringify({ ...draft, values }));
  } catch {
    // Storage blocked: the form still works, it just isn't kept.
  }
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
  const [tunnelReady, setTunnelReady] = useState(false);
  const [storageTyped, setStorageTyped] = useState(false);
  const action = useAction();

  useEffect(() => {
    if (!bundle || ready) return;
    const draft = loadDraft(bundle);
    setValues({ ...initialBundleValues(bundle), ...draft?.values });
    setInclude(draft?.include ?? initialInclude(bundle));
    setStorageTyped(draft?.storageTyped ?? false);
    setReady(true);
  }, [bundle, ready]);

  useEffect(() => {
    if (bundle && ready) saveDraft(bundle, { values, include, storageTyped });
  }, [bundle, ready, values, include, storageTyped]);

  // Ticking or unticking Longhorn moves the storage class with it, unless
  // the user typed their own.
  useEffect(() => {
    if (!bundle || !ready || storageTyped || !bundle.inputs.some((i) => i.key === STORAGE_CLASS)) return;
    const next = defaultStorageClass(bundle, include);
    setValues((prev) => (prev[STORAGE_CLASS] === next ? prev : { ...prev, [STORAGE_CLASS]: next }));
  }, [bundle, ready, include, storageTyped]);

  // Reopening the page while a rollout runs goes straight back to it.
  const active = runs.data?.find((run) => run.state === "running");
  const shownRun = runId ?? active?.id;

  if (bundles.error) return <Alert color="red">{bundles.error}</Alert>;
  if (!bundle || !ready) return <Loader size="sm" />;
  const names = Object.fromEntries((discovery.apps ?? []).map((app) => [app.id, app.name]));
  const name = (appId: string) => names[appId] ?? appId;

  if (shownRun) return <BundleRun runId={shownRun} names={names} onDone={onDone} />;

  // Answers to inputs that don't apply (a tunnel token from before the
  // connector was picked) stay out of the request.
  const applies = (key: string) => {
    const input = bundle.inputs.find((i) => i.key === key);
    return !input || holds(input.when, values, bundle.inputs);
  };
  const answers = () => Object.fromEntries(Object.entries(values).filter(([key]) => applies(key)));
  const request = () => ({ bundleId: bundle.id, inputs: answers(), include });

  async function preview() {
    const next = await action.run(async () => {
      // Through the connector the tunnel already exists: saving the access
      // choice now lets the connector publish each app as it lands.
      const baseDomain = typeof values.baseDomain === "string" ? values.baseDomain.trim() : "";
      if (viaApi && values.access === "cloudflare-tunnel" && baseDomain) {
        await apiRequest("PUT /api/deploy/access", { body: { mode: "cloudflare-tunnel", baseDomain } });
        await apiRequest("POST /api/connector-cloudflare/sync").catch(() => undefined);
      }
      return apiRequest("POST /api/deploy/bundles/plan", { body: request() });
    });
    if (next) setPlan(next);
  }

  async function start() {
    const run = await action.run(() => apiRequest("POST /api/deploy/bundles", { body: request() }));
    if (run) {
      saveDraft(bundle!, undefined);
      setRunId(run.id);
    }
  }

  const off = status.data ? !status.data.enabled : false;
  const onLonghorn = include.includes("longhorn") && values[STORAGE_CLASS] === LONGHORN_CLASS;
  const inputs = bundle.inputs
    .filter((input) => holds(input.when, values, bundle.inputs))
    .map((input) =>
      input.key === STORAGE_CLASS && onLonghorn
        ? { ...input, help: "Longhorn, which this rollout installs. Clear it for the cluster's default." }
        : input
    );
  const items = bundle.items.filter((item) => holds(item.when, values, bundle.inputs));
  const setupAt = inputs.findIndex((input) => input.key === CLOUDFLARE_SETUP);
  const viaApi = setupAt !== -1 && values[CLOUDFLARE_SETUP] === "api";
  const set = (key: string, value: DeployValue) => {
    if (key === STORAGE_CLASS) setStorageTyped(true);
    setValues((prev) => ({ ...prev, [key]: value }));
  };
  const form = (list: typeof inputs) =>
    list.length ? <DeployInputsForm inputs={list} values={values} onChange={set} /> : null;
  const missingRequired = inputs.some(
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
      {setupAt === -1 ? (
        form(inputs)
      ) : (
        <>
          {form(inputs.slice(0, setupAt))}
          <CloudflareChoice
            how={viaApi ? "api" : "token"}
            onChange={(how) => set(CLOUDFLARE_SETUP, how)}
            baseDomain={typeof values.baseDomain === "string" ? values.baseDomain.trim() : undefined}
            onReady={setTunnelReady}
          />
          {form(inputs.slice(setupAt + 1))}
        </>
      )}
      <Stack gap={6}>
        <Title order={5}>What it rolls out</Title>
        {items.map((item) => (
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
        <Button
          loading={action.busy}
          disabled={missingRequired || (viaApi && !tunnelReady)}
          onClick={() => void preview()}
        >
          Preview
        </Button>
      </Group>
    </Stack>
  );
}

// Cloudflare Tunnel through the connector or with a pasted tunnel token,
// as in the Access step. Through the connector, the tunnel has to exist
// before the rollout, so each app's route is added as it lands.
function CloudflareChoice({
  how,
  onChange,
  baseDomain,
  onReady,
}: {
  how: "api" | "token";
  onChange: (how: "api" | "token") => void;
  baseDomain?: string;
  onReady: (ready: boolean) => void;
}) {
  return (
    <Stack gap="sm" data-cloudflare-setup={how}>
      <SegmentedControl
        value={how}
        onChange={(value) => onChange(value as "api" | "token")}
        data={[
          { value: "api", label: "Connect with an API token (recommended)" },
          { value: "token", label: "Paste a tunnel token" },
        ]}
      />
      {how === "api" ? <ConnectorSetup baseDomain={baseDomain} onReady={onReady} /> : null}
    </Stack>
  );
}

function ConnectorSetup({ baseDomain, onReady }: { baseDomain?: string; onReady: (ready: boolean) => void }) {
  const [ready, setReady] = useState(false);
  // The panel below keeps its own copy of the view; this one only watches
  // for a cloudflared to connect to the tunnel, which the bundle doesn't
  // deploy on this path.
  const view = useApi("GET /api/connector-cloudflare/view", undefined, { pollMs: ready ? undefined : RUN_POLL_MS });
  const tunnel = view.data?.tunnel;
  const connected = tunnel?.status === "healthy" || tunnel?.status === "degraded";
  useEffect(() => {
    setReady(connected);
    onReady(connected);
  }, [connected, onReady]);
  useEffect(() => () => onReady(false), [onReady]);
  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Connect your Cloudflare account, create the tunnel and deploy cloudflared here. The rollout then adds a DNS
        record and tunnel route for each app as it lands.
      </Text>
      <CloudflarePanel baseDomain={baseDomain} {...(ready ? {} : { pollMs: RUN_POLL_MS })} />
      {view.data && !connected ? (
        <Text size="sm" c="yellow">
          {tunnel
            ? "Preview opens once cloudflared is connected to the tunnel: deploy it above."
            : "Preview opens once the tunnel exists and cloudflared is connected to it."}
        </Text>
      ) : null}
    </Stack>
  );
}

// With the connector set up, its panel shows each app's DNS record and
// route; otherwise the steps to finish by hand.
function AfterRollout({ access }: { access: AccessView }) {
  const cloudflare = access.mode === "cloudflare-tunnel";
  const view = useApi("GET /api/connector-cloudflare/view", undefined, { enabled: cloudflare });
  if (cloudflare && !view.data && !view.error) return null;
  if (cloudflare && view.data?.connectorId) return <CloudflarePanel baseDomain={access.baseDomain} />;
  return <AccessInstructions view={access} />;
}

function BundleRun({ runId, names, onDone }: { runId: string; names: Record<string, string>; onDone: () => void }) {
  const [finished, setFinished] = useState(false);
  const run = useApi(
    "GET /api/deploy/bundles/:id",
    { params: { id: runId } },
    { pollMs: finished ? undefined : RUN_POLL_MS }
  );
  const discovery = useDiscovery();
  const access = useApi("GET /api/deploy/access", undefined, { pollMs: finished ? undefined : RUN_POLL_MS });
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
      {data.state !== "running" && access.data ? <AfterRollout access={access.data} /> : null}
      {data.state === "failed" ? <RunFailed run={data} names={names} /> : null}
      <Group justify="flex-end">
        <Button disabled={data.state === "running"} onClick={onDone}>
          Continue setup
        </Button>
      </Group>
    </Stack>
  );
}

function RunFailed({ run, names }: { run: BundleRunView; names: Record<string, string> }) {
  const { kind, stoppedAt, failed } = runFailures(run);
  const name = (appId: string) => names[appId] ?? appId;
  return (
    <Alert
      color={kind === "stopped" ? "red" : "yellow"}
      title={
        kind === "stopped" && stoppedAt
          ? `Stopped at ${name(stoppedAt)}`
          : kind === "stopped"
            ? "Stopped"
            : "Finished with failures"
      }
      data-run-outcome={kind}
    >
      <Stack gap={6}>
        <Text size="sm">
          {kind === "stopped"
            ? "A required app failed, so the apps after it were not installed. What installed before it stays."
            : "Every app ran; the ones below are optional and failed, and everything else is installed."}
        </Text>
        {failed.map((step) => (
          <Text key={step.appId} size="sm" data-failed={step.appId}>
            <b>{name(step.appId)}</b>
            {step.message ? `: ${step.message}` : ""}
          </Text>
        ))}
        <Text size="sm">
          Fix the cause from the log and open the bundle again from Setup; it skips whatever is already installed.
        </Text>
      </Stack>
    </Alert>
  );
}

import { useCallback, useContext, useState } from "react";
import { Alert, Anchor, Badge, Button, Group, Stack, Table, Text, Tooltip } from "@mantine/core";
import { IconExternalLink, IconPlus } from "@tabler/icons-react";
import { Link } from "react-router";
import type { BackupPosture, LonghornReplicaAdvice } from "@contracts/backups";
import type { CatalogAppView } from "@contracts/catalog";
import type { ManagedBy } from "@contracts/k8s";
import type { AppGateView, PortsView, UpgradeCandidate, UpgradeReport } from "@contracts/deploy";
import {
  CUSTOM_TEMPLATE,
  type AppTemplate,
  type ExternalServiceSpec,
  type TemplateInstance,
} from "@contracts/templates";
import { PageHeader } from "../../shell/PageHeader";
import { useApi } from "../../ui";
import { DeploysOff, JOB_STATE_COLOR } from "../../ui/deploy";
import { SessionContext } from "../../ui/session";
import { ForwardedPortsPanel } from "../templates/ForwardedPorts";
import { RemoveAppButton } from "../templates/RemoveApp";
import { formFromInstance, isForwardedProtocol } from "../templates/request";
import { useTemplateDialog } from "../templates/TemplatesTab";
import { ConvertToLonghornButton } from "./ConvertToLonghorn";
import { GatePublicSwitch, GateStateBadge } from "./SignInGate";
import { FromTo, UpgradeAllButton, UpgradeModal, UpgradeStateBadge, canUpgrade } from "./Upgrades";

const POLL_MS = 5_000;

// One installed app, from the catalog's discovery or a template instance.
export interface InstalledRow {
  id: string;
  name: string;
  namespace?: string;
  version?: string;
  // "Chart", "Manifest", "Custom image", "External UDP 10.0.0.50:2456".
  source: string;
  storage?: string;
  urls: string[];
  // For a TCP or UDP external service: where people connect.
  direct?: string;
  status: { label: string; color: string; detail?: string };
  ownedByUs: boolean;
  keepsData: boolean;
  app?: CatalogAppView;
  instance?: TemplateInstance;
  upgrade?: UpgradeCandidate;
  gate?: AppGateView;
}

const hostPort = (address: string, port: number) => `${address.includes(":") ? `[${address}]` : address}:${port}`;

function externalSource(spec: ExternalServiceSpec): string {
  return `External ${spec.protocol.toUpperCase()} ${hostPort(spec.address, spec.port)}`;
}

// Whether converting could find anything to move: false once every claim in
// the namespace is already on a Longhorn class, or it has none. Undefined
// (keep the button) while either answer is missing; the plan then says why.
export function hasNonLonghornClaims(
  namespace: string | undefined,
  posture: BackupPosture | undefined,
  longhorn: LonghornReplicaAdvice | undefined
): boolean | undefined {
  if (!namespace || !posture || !longhorn || longhorn.state === "absent") return undefined;
  const longhornClasses = new Set(["longhorn", ...longhorn.storageClasses.map((c) => c.name)]);
  return posture.rows.some(
    (r) => r.pvc.namespace === namespace && !(r.pvc.storageClass && longhornClasses.has(r.pvc.storageClass))
  );
}

const MANAGED_BY: Record<ManagedBy, string> = { fleet: "Fleet", helm: "Helm", argo: "Argo CD" };

function managedBy(app: CatalogAppView): string | undefined {
  const m = app.detected.managedBy;
  return app.detected.ownedByUs || !m ? undefined : MANAGED_BY[m];
}

export function installedRows(
  apps: readonly CatalogAppView[],
  instances: readonly TemplateInstance[],
  upgrades: UpgradeReport | undefined,
  gate: readonly AppGateView[],
  ports?: PortsView
): InstalledRow[] {
  const upgradeOf = (id: string) => upgrades?.apps.find((u) => u.appId === id);
  const gateOf = (id: string) => gate.find((g) => g.appId === id);
  const rows: InstalledRow[] = [];
  for (const app of apps) {
    const d = app.detected;
    if (d.state !== "installed" || app.install.kind === "patch") continue;
    const by = managedBy(app);
    rows.push({
      id: app.id,
      name: app.name,
      namespace: d.namespace,
      version: d.version ?? d.chartVersion,
      source: `${app.install.kind === "helm" ? "Chart" : "Manifest"}${by ? ` (managed by ${by})` : ""}`,
      ...(app.storage ? { storage: app.storage } : {}),
      urls: d.urls,
      status: { label: d.ownedByUs ? "deployed from here" : "found", color: "green", detail: d.evidence },
      ownedByUs: d.ownedByUs,
      keepsData: Boolean(app.storage),
      app,
      upgrade: upgradeOf(app.id),
      gate: gateOf(app.id),
    });
  }
  for (const instance of instances) {
    const ext = instance.external;
    const job = instance.lastJob;
    const forwarded = ext && isForwardedProtocol(ext.protocol);
    const publicPort = ext ? (ext.publicPort ?? ext.port) : undefined;
    rows.push({
      id: instance.name,
      name: instance.name,
      namespace: instance.namespace,
      ...(ext ? {} : { version: instance.version }),
      source: ext
        ? externalSource(ext)
        : instance.templateId === CUSTOM_TEMPLATE
          ? "Custom image"
          : `Template (${instance.templateId})`,
      ...(instance.volumeSize || instance.storageClass
        ? { storage: [instance.volumeSize, instance.storageClass ?? "default class"].filter(Boolean).join(" on ") }
        : {}),
      urls: instance.url ? [instance.url] : [],
      ...(forwarded ? { direct: `${ports?.address ?? "your public address"}:${publicPort}` } : {}),
      status: job
        ? { label: job.state, color: JOB_STATE_COLOR[job.state], detail: job.message }
        : { label: "deployed", color: "green" },
      ownedByUs: true,
      keepsData: Boolean(instance.volumeSize),
      instance,
      upgrade: upgradeOf(instance.name),
      gate: gateOf(instance.name),
    });
  }
  // Deployed from here by the runner's own record although discovery
  // didn't see it (or couldn't tell).
  const seen = new Set(rows.map((row) => row.id));
  for (const upgrade of upgrades?.apps ?? []) {
    if (seen.has(upgrade.appId)) continue;
    const app = apps.find((a) => a.id === upgrade.appId);
    rows.push({
      id: upgrade.appId,
      name: app?.name ?? upgrade.appId,
      namespace: upgrade.namespace,
      version: upgrade.currentVersion,
      source: app?.install.kind === "manifest" ? "Manifest" : "Chart",
      ...(app?.storage ? { storage: app.storage } : {}),
      urls: upgrade.url ? [upgrade.url] : (app?.detected.urls ?? []),
      status: {
        label: "deployed from here",
        color: "green",
        ...(app ? { detail: app.detected.evidence } : {}),
      },
      ownedByUs: true,
      keepsData: Boolean(app?.storage),
      ...(app ? { app } : {}),
      upgrade,
      gate: gateOf(upgrade.appId),
    });
  }
  for (const g of gate) {
    if (seen.has(g.appId) || rows.some((row) => row.id === g.appId)) continue;
    const app = apps.find((a) => a.id === g.appId);
    rows.push({
      id: g.appId,
      name: g.name,
      namespace: app?.detected.namespace,
      source: app?.install.kind === "manifest" ? "Manifest" : "Chart",
      urls: app?.detected.urls ?? [],
      status: { label: "deployed from here", color: "green" },
      ownedByUs: true,
      keepsData: Boolean(app?.storage),
      ...(app ? { app } : {}),
      gate: g,
    });
  }
  return rows.toSorted((a, b) => a.name.localeCompare(b.name));
}

function Address({ row }: { row: InstalledRow }) {
  if (row.urls.length > 0) {
    return (
      <Stack gap={2}>
        {row.urls.map((url) => (
          <Anchor key={url} href={url} target="_blank" rel="noreferrer" size="sm">
            <Group gap={4} wrap="nowrap">
              {url}
              <IconExternalLink size={12} />
            </Group>
          </Anchor>
        ))}
      </Stack>
    );
  }
  if (row.direct) {
    return (
      <Tooltip
        label="Direct: reached on the cluster's address at the public port your router forwards."
        multiline
        maw={300}
      >
        <Text size="sm">{row.direct}</Text>
      </Tooltip>
    );
  }
  return (
    <Text size="sm" c="dimmed">
      inside the cluster only
    </Text>
  );
}

function Row({
  row,
  admin,
  enabled,
  template,
  convertible,
  onUpgrade,
  onRedeploy,
  onChanged,
}: {
  row: InstalledRow;
  admin: boolean;
  enabled: boolean;
  convertible?: boolean;
  template?: AppTemplate;
  onUpgrade: (app: UpgradeCandidate) => void;
  onRedeploy: () => void;
  onChanged: () => void;
}) {
  const allowed = admin && enabled;
  const upgrade = row.upgrade;
  return (
    <Table.Tr data-installed={row.id}>
      <Table.Td>
        <Text size="sm" fw={500}>
          {row.name}
        </Text>
        <Text size="xs" c="dimmed">
          {row.source}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{row.namespace ?? "—"}</Text>
      </Table.Td>
      <Table.Td>
        {upgrade && upgrade.state === "available" ? (
          <Stack gap={2}>
            <FromTo app={upgrade} />
            <UpgradeStateBadge app={upgrade} />
          </Stack>
        ) : (
          <Text size="sm">{row.version ?? "—"}</Text>
        )}
      </Table.Td>
      <Table.Td>
        <Text size="sm">{row.storage ?? "—"}</Text>
      </Table.Td>
      <Table.Td>
        <Address row={row} />
      </Table.Td>
      <Table.Td>
        <Tooltip label={row.status.detail} disabled={!row.status.detail} multiline maw={360}>
          <Badge color={row.status.color} variant="light" radius="xs">
            {row.status.label}
          </Badge>
        </Tooltip>
      </Table.Td>
      <Table.Td>
        {row.gate ? (
          <Group gap={6} wrap="nowrap" data-gate-app={row.gate.appId} data-gate-state={row.gate.state}>
            <GatePublicSwitch app={row.gate} onChanged={onChanged} />
            <GateStateBadge app={row.gate} />
          </Group>
        ) : row.direct ? (
          <Text size="xs" c="dimmed">
            direct
          </Text>
        ) : (
          <Text size="xs" c="dimmed">
            —
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <Group gap={4} wrap="nowrap" justify="flex-end">
          {upgrade && canUpgrade(upgrade) ? (
            <Button size="xs" variant="light" disabled={!allowed} onClick={() => onUpgrade(upgrade)}>
              Upgrade
            </Button>
          ) : null}
          {row.ownedByUs && row.keepsData && admin && !row.instance?.external && convertible !== false ? (
            <ConvertToLonghornButton appId={row.id} name={row.name} onFinished={onChanged} />
          ) : null}
          {row.instance && template ? (
            <Button size="xs" variant="subtle" disabled={!allowed} onClick={onRedeploy}>
              {row.instance.external ? "Edit" : "Deploy again"}
            </Button>
          ) : null}
          {row.instance ? <RemoveAppButton instance={row.instance} disabled={!allowed} onRemoved={onChanged} /> : null}
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

// Everything installed, whoever installed it, with what can be done to each.
export function InstalledPage() {
  const admin = useContext(SessionContext)?.me.admin ?? true;
  const [refresh, setRefresh] = useState(false);
  const apps = useApi("GET /api/catalog/apps", { query: refresh ? { refresh: "1" } : {} });
  const templates = useApi("GET /api/templates", undefined, { pollMs: POLL_MS });
  const upgrades = useApi("GET /api/deploy/upgrades");
  const gate = useApi("GET /api/deploy/gate");
  const status = useApi("GET /api/deploy/status");
  const ports = useApi("GET /api/deploy/ports");
  const posture = useApi("GET /api/backups/posture");
  const longhorn = useApi("GET /api/longhorn/replicas");
  const [picked, setPicked] = useState<UpgradeCandidate[] | null>(null);

  const reloads = [apps.reload, templates.reload, upgrades.reload, gate.reload, ports.reload, posture.reload];
  const changed = useCallback(() => {
    setRefresh(true);
    for (const reload of reloads) reload();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, reloads);
  const { open, dialog } = useTemplateDialog(changed);

  const rows = installedRows(
    apps.data ?? [],
    templates.data?.instances ?? [],
    upgrades.data ?? undefined,
    gate.data?.apps ?? [],
    ports.data ?? undefined
  );
  const names = Object.fromEntries(rows.map((row) => [row.id, row.name]));
  const enabled = status.data?.enabled !== false;
  const hasForwarded = (ports.data?.wanted.length ?? 0) > 0 || (ports.data?.open.length ?? 0) > 0;
  const error = apps.error ?? templates.error ?? upgrades.error;

  return (
    <>
      <PageHeader
        title="Installed"
        description="Every app in the cluster this console knows about, and what you can do with each. Nothing upgrades by itself."
        actions={
          <Group gap="xs">
            <Button component={Link} to="/apps/deploy" variant="default" size="xs" leftSection={<IconPlus size={14} />}>
              Deploy
            </Button>
            <UpgradeAllButton report={upgrades.data ?? undefined} onPick={setPicked} />
          </Group>
        }
      />
      <Stack gap="lg">
        {status.data && !status.data.enabled ? (
          <Alert color="blue" variant="light" title="Deploys are off">
            <DeploysOff status={status.data} />
          </Alert>
        ) : null}
        {gate.data && !gate.data.ready && gate.data.reason ? (
          <Alert color="yellow" variant="light" title="The sign-in gate can't be put in front of apps">
            {gate.data.reason}
          </Alert>
        ) : null}
        {error ? (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        ) : null}
        {rows.length === 0 && !apps.loading ? (
          <Text size="sm" c="dimmed">
            Nothing installed yet.{" "}
            <Anchor component={Link} to="/apps/deploy">
              Deploy an app
            </Anchor>
            .
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={960}>
            <Table verticalSpacing="xs" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>App</Table.Th>
                  <Table.Th>Space</Table.Th>
                  <Table.Th>Version</Table.Th>
                  <Table.Th>Storage</Table.Th>
                  <Table.Th>Address</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Public</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((row) => {
                  const template = row.instance
                    ? templates.data?.templates.find((t) => t.id === row.instance!.templateId)
                    : undefined;
                  return (
                    <Row
                      key={row.id}
                      row={row}
                      admin={admin}
                      enabled={enabled}
                      template={template}
                      convertible={hasNonLonghornClaims(
                        row.namespace,
                        posture.data ?? undefined,
                        longhorn.data ?? undefined
                      )}
                      onUpgrade={(app) => setPicked([app])}
                      onRedeploy={() =>
                        template && row.instance && open(template, formFromInstance(template, row.instance))
                      }
                      onChanged={changed}
                    />
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
        {hasForwarded && ports.data ? <ForwardedPortsPanel view={ports.data} onChanged={changed} /> : null}
      </Stack>
      <UpgradeModal apps={picked} names={names} onClose={() => setPicked(null)} onFinished={changed} />
      {dialog}
    </>
  );
}

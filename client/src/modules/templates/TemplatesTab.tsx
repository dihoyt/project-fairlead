import { useContext, useState } from "react";
import { Alert, Anchor, Badge, Button, Card, Group, List, SimpleGrid, Stack, Text, Tooltip } from "@mantine/core";
import { IconRocket } from "@tabler/icons-react";
import { EXTERNAL_TEMPLATE, type AppTemplate } from "@contracts/templates";
import { useApi } from "../../ui";
import { SessionContext } from "../../ui/session";
import { WhatIsThis } from "../../ui/deploy";
import { ForwardedPortsPanel, usePorts } from "./ForwardedPorts";
import { emptyForm, type TemplateForm } from "./request";
import { TemplateDialog } from "./TemplateDialog";

interface Opened {
  template: AppTemplate;
  initial: TemplateForm;
}

function TemplateCard({ template, admin, onDeploy }: { template: AppTemplate; admin: boolean; onDeploy: () => void }) {
  return (
    <Card withBorder padding="sm" data-template={template.id}>
      <Stack gap={6} h="100%">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          {template.homepage ? (
            <Anchor href={template.homepage} target="_blank" rel="noreferrer" fw={600} c="inherit">
              {template.name}
            </Anchor>
          ) : (
            <Text fw={600}>{template.name}</Text>
          )}
          {template.version ? (
            <Badge variant="light" color="gray" radius="xs">
              {template.version}
            </Badge>
          ) : null}
        </Group>
        <WhatIsThis>{template.summary}</WhatIsThis>
        <Group mt="auto" justify="flex-end">
          <Tooltip label="Only admins can deploy apps" disabled={admin}>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconRocket size={14} />}
              disabled={!admin}
              onClick={onDeploy}
            >
              Deploy
            </Button>
          </Tooltip>
        </Group>
      </Stack>
    </Card>
  );
}

// The dialog for one template, opened from a card or an Installed row.
export function useTemplateDialog(onDeployed: () => void) {
  const status = useApi("GET /api/deploy/status");
  const [opened, setOpened] = useState<Opened | null>(null);
  const dialog = opened ? (
    <TemplateDialog
      key={`${opened.template.id}:${opened.initial.name}`}
      template={opened.template}
      initial={opened.initial}
      baseDomain={status.data?.defaults.baseDomain}
      defaultStorageClass={status.data?.defaults.storageClass}
      onClose={() => setOpened(null)}
      onDeployed={onDeployed}
    />
  ) : null;
  return { open: (template: AppTemplate, initial: TemplateForm) => setOpened({ template, initial }), dialog };
}

function useDeployAllowed(): boolean {
  // Outside the signed-in shell (tests) the server's admin check is the only gate.
  const admin = useContext(SessionContext)?.me.admin ?? true;
  const status = useApi("GET /api/deploy/status");
  return admin && status.data?.enabled !== false;
}

// The starter library and Custom app.
export function TemplatesTab({ onDeployed }: { onDeployed: () => void }) {
  const allowed = useDeployAllowed();
  const view = useApi("GET /api/templates");
  const { open, dialog } = useTemplateDialog(onDeployed);
  const templates = (view.data?.templates ?? []).filter((t) => t.id !== EXTERNAL_TEMPLATE);
  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Small apps to run in your cluster: a starter library, or your own container image as a Custom app. Each gets its
        own namespace, guarded against host access and privileged containers.
      </Text>
      {view.error ? (
        <Alert color="red" variant="light">
          {view.error}
        </Alert>
      ) : null}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        {templates.map((template) => (
          <TemplateCard
            key={template.id}
            template={template}
            admin={allowed}
            onDeploy={() => open(template, emptyForm(template))}
          />
        ))}
      </SimpleGrid>
      {dialog}
    </Stack>
  );
}

// Something outside the cluster, published through its Traefik.
export function ExternalTab({ onDeployed }: { onDeployed: () => void }) {
  const allowed = useDeployAllowed();
  const view = useApi("GET /api/templates");
  const ports = usePorts();
  const { open, dialog } = useTemplateDialog(() => {
    ports.reload();
    onDeployed();
  });
  const template = view.data?.templates.find((t) => t.id === EXTERNAL_TEMPLATE);
  return (
    <Stack gap="md">
      <Text size="sm">
        Publish something that runs outside the cluster, like a game server on a VM, a NAS page or another machine's web
        app, through the cluster's Traefik.
      </Text>
      <List size="sm" spacing={4}>
        <List.Item>
          <b>HTTP or HTTPS</b> gets a hostname like any app: your access mode applies, the console's sign-in sits in
          front unless you make it public, and the Cloudflare connector gives it a tunnel route and DNS record.
        </List.Item>
        <List.Item>
          <b>TCP or UDP</b> is published on a port your router forwards to the cluster. It can't go through a Cloudflare
          tunnel on the free plan, so it is direct only.
        </List.Item>
        <List.Item>
          When the public port differs from the service's own, protocols that tell clients their port (some game server
          browsers, FTP, SIP) may only work when reached directly.
        </List.Item>
      </List>
      <Group>
        <Tooltip label="Only admins can deploy apps" disabled={allowed}>
          <Button
            leftSection={<IconRocket size={16} />}
            disabled={!allowed || !template}
            onClick={() => template && open(template, emptyForm(template))}
          >
            Add an external service
          </Button>
        </Tooltip>
      </Group>
      {ports.error ? (
        <Alert color="red" variant="light">
          {ports.error}
        </Alert>
      ) : null}
      {ports.data ? <ForwardedPortsPanel view={ports.data} onChanged={ports.reload} /> : null}
      {dialog}
    </Stack>
  );
}

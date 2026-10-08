import { useContext, useState } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconExternalLink, IconRocket } from "@tabler/icons-react";
import type { AppTemplate, TemplateInstance } from "@contracts/templates";
import { PageHeader } from "../../shell/PageHeader";
import { relativeTime, useApi } from "../../ui";
import { SessionContext } from "../../ui/session";
import { DeploysOff, JOB_STATE_COLOR, WhatIsThis } from "../../ui/deploy";
import { emptyForm, formFromInstance, type TemplateForm } from "./request";
import { RemoveAppButton } from "./RemoveApp";
import { TemplateDialog } from "./TemplateDialog";

const POLL_MS = 5_000;

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

function InstanceRow({
  instance,
  template,
  admin,
  onRedeploy,
  onRemoved,
}: {
  instance: TemplateInstance;
  template?: AppTemplate;
  admin: boolean;
  onRedeploy: () => void;
  onRemoved: () => void;
}) {
  const job = instance.lastJob;
  return (
    <Table.Tr data-instance={instance.name}>
      <Table.Td>
        <Text size="sm" fw={500}>
          {instance.name}
        </Text>
        <Text size="xs" c="dimmed">
          {template?.name ?? instance.templateId}
        </Text>
      </Table.Td>
      <Table.Td>
        <Group gap={6}>
          <Text size="sm">{instance.version}</Text>
          {instance.newerVersion ? (
            <Tooltip label="Upgrade it from Apps > Upgrades, or deploy it again.">
              <Badge size="xs" color="cyan" variant="light">
                {instance.newerVersion} available
              </Badge>
            </Tooltip>
          ) : null}
        </Group>
      </Table.Td>
      <Table.Td>
        {instance.url ? (
          <Anchor href={instance.url} target="_blank" rel="noreferrer" size="sm">
            <Group gap={4} wrap="nowrap">
              {instance.url}
              <IconExternalLink size={12} />
            </Group>
          </Anchor>
        ) : (
          <Text size="sm" c="dimmed">
            {instance.host || "inside the cluster only"}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        {job ? (
          <Tooltip label={job.message ?? job.state} multiline maw={360}>
            <Badge color={JOB_STATE_COLOR[job.state]} variant="light" radius="xs">
              {job.state}
            </Badge>
          </Tooltip>
        ) : (
          <Text size="xs" c="dimmed">
            no recent job
          </Text>
        )}
        <Text size="xs" c="dimmed">
          {relativeTime(instance.updatedAt)}
        </Text>
      </Table.Td>
      <Table.Td>
        <Group gap={4} wrap="nowrap" justify="flex-end">
          {template ? (
            <Button size="xs" variant="subtle" disabled={!admin} onClick={onRedeploy}>
              Deploy again
            </Button>
          ) : null}
          <RemoveAppButton instance={instance} disabled={!admin} onRemoved={onRemoved} />
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

export function TemplatesPage() {
  // Outside the signed-in shell (tests) the server's admin check is the only gate.
  const admin = useContext(SessionContext)?.me.admin ?? true;
  const [opened, setOpened] = useState<Opened | null>(null);
  const status = useApi("GET /api/deploy/status");
  const view = useApi("GET /api/templates", undefined, { pollMs: POLL_MS });
  const templates = view.data?.templates ?? [];
  const instances = view.data?.instances ?? [];

  return (
    <>
      <PageHeader
        title="Templates"
        description="Small apps to run in your cluster: a starter library, or your own container image as a Custom app. Each gets its own namespace, guarded against host access and privileged containers."
      />
      <Stack gap="lg">
        {view.error ? (
          <Alert color="red" variant="light">
            {view.error}
          </Alert>
        ) : null}
        {status.data && !status.data.enabled ? (
          <Alert color="yellow" variant="light">
            <DeploysOff status={status.data} />
          </Alert>
        ) : null}

        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              admin={admin && status.data?.enabled !== false}
              onDeploy={() => setOpened({ template, initial: emptyForm(template) })}
            />
          ))}
        </SimpleGrid>

        <Stack gap="xs">
          <Title order={4}>Deployed from templates</Title>
          {instances.length === 0 ? (
            <Text size="sm" c="dimmed">
              Nothing yet. Apps you deploy here also show on the Apps page, under Upgrades and in Workloads.
            </Text>
          ) : (
            <Table.ScrollContainer minWidth={640}>
              <Table verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>App</Table.Th>
                    <Table.Th>Version</Table.Th>
                    <Table.Th>Address</Table.Th>
                    <Table.Th>Last deploy</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {instances.map((instance) => {
                    const template = templates.find((t) => t.id === instance.templateId);
                    return (
                      <InstanceRow
                        key={instance.name}
                        instance={instance}
                        template={template}
                        admin={admin && status.data?.enabled !== false}
                        onRedeploy={() =>
                          template && setOpened({ template, initial: formFromInstance(template, instance) })
                        }
                        onRemoved={view.reload}
                      />
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Stack>
      </Stack>

      {opened ? (
        <TemplateDialog
          key={`${opened.template.id}:${opened.initial.name}`}
          template={opened.template}
          initial={opened.initial}
          baseDomain={status.data?.defaults.baseDomain}
          defaultStorageClass={status.data?.defaults.storageClass}
          onClose={() => setOpened(null)}
          onDeployed={view.reload}
        />
      ) : null}
    </>
  );
}

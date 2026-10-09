import { useCallback, useState } from "react";
import { Alert, Stack, Tabs } from "@mantine/core";
import { useNavigate, useParams } from "react-router";
import { PageHeader } from "../../shell/PageHeader";
import { useApi } from "../../ui";
import { DeploysOff } from "../../ui/deploy";
import { ExternalTab, TemplatesTab } from "../templates/TemplatesTab";
import { CatalogTab } from "./CatalogTab";
import { RecentDeploys } from "./RecentDeploys";

export const DEPLOY_TABS = ["catalog", "templates", "external"] as const;
type DeployTab = (typeof DEPLOY_TABS)[number];

const isTab = (value: string | undefined): value is DeployTab => DEPLOY_TABS.includes(value as DeployTab);

// One place to add anything: catalog apps, the template library and Custom
// app, and services running outside the cluster.
export function DeployPage() {
  const params = useParams();
  const navigate = useNavigate();
  const tab: DeployTab = isTab(params.tab) ? params.tab : "catalog";
  const status = useApi("GET /api/deploy/status");
  const catalog = useApi("GET /api/catalog/apps");
  const [jobsKey, setJobsKey] = useState(0);
  const deployed = useCallback(() => setJobsKey((k) => k + 1), []);
  const names = Object.fromEntries((catalog.data ?? []).map((app) => [app.id, app.name]));

  return (
    <>
      <PageHeader
        title="Deploy"
        description="Add an app from the catalog, a template, your own image, or something outside the cluster."
      />
      <Stack gap="xl">
        {status.data && !status.data.enabled ? (
          <Alert color="blue" variant="light" title="Deploys are off">
            <DeploysOff status={status.data} />
          </Alert>
        ) : null}
        <Tabs
          value={tab}
          onChange={(value) => isTab(value ?? undefined) && navigate(`/apps/deploy/${value}`)}
          keepMounted={false}
        >
          <Tabs.List mb="md">
            <Tabs.Tab value="catalog">Catalog</Tabs.Tab>
            <Tabs.Tab value="templates">Templates and custom apps</Tabs.Tab>
            <Tabs.Tab value="external">External service</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="catalog">
            <CatalogTab onDeployed={deployed} />
          </Tabs.Panel>
          <Tabs.Panel value="templates">
            <TemplatesTab onDeployed={deployed} />
          </Tabs.Panel>
          <Tabs.Panel value="external">
            <ExternalTab onDeployed={deployed} />
          </Tabs.Panel>
        </Tabs>
        <RecentDeploys key={jobsKey} names={names} />
      </Stack>
    </>
  );
}

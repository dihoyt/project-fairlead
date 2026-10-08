import { useEffect, useState } from "react";
import { Alert, Loader, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useApi } from "../../../ui";
import { AppOffer, DiscoveryNote, useDiscovery } from "../discovery";
import { LINK_FIELD, linksFromDiscovery } from "../links";
import { LinksFields, useLinksForm } from "../LinksForm";
import { StepFrame, type StepProps } from "../shared";

export function LinksStep({ onFinish }: StepProps) {
  const overview = useApi("GET /api/admin/overview");
  const links = useLinksForm(overview.data?.settings, overview.reload);
  const discovery = useDiscovery();
  const [prefilled, setPrefilled] = useState<string[]>([]);
  const tools = discovery.inSlot("links").filter((app) => app.linkKey);

  // Once, after the saved settings are in the form: fill what is still empty
  // from the Ingresses discovery found.
  const { loaded, fill } = links;
  const apps = discovery.apps;
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    if (!loaded || !apps || filled) return;
    setFilled(true);
    const found = linksFromDiscovery(apps);
    const empty = (Object.keys(found) as Array<keyof typeof found>).filter((key) => !links.form[key].trim());
    fill(found);
    setPrefilled(apps.filter((app) => app.linkKey && empty.includes(LINK_FIELD[app.linkKey])).map((app) => app.name));
  }, [loaded, apps, filled, fill, links.form]);

  return (
    <StepFrame
      onFinish={async (done) => {
        if (done && !links.saved && !(await links.submit())) throw new Error("Not saved; see the error above.");
        await onFinish(done);
      }}
      what="Web consoles for the cluster: Rancher and Headlamp to manage it, Longhorn for its disks, Gitea for your code, Grafana for graphs."
      intro="The tools you already use. Checks, workloads and category pages link straight into them; leave any you don't run empty, or deploy one below."
      fullPage={{ to: "/admin/settings", label: "All settings" }}
      finishLabel="Save and continue"
    >
      {overview.loading && !overview.data ? <Loader size="sm" /> : null}
      {overview.error ? <Alert color="red">{overview.error}</Alert> : null}
      {prefilled.length ? (
        <Text size="sm" c="teal" data-prefilled>
          Filled in from what is in the cluster: {prefilled.join(", ")}. Check them, then save.
        </Text>
      ) : null}
      <LinksFields form={links.form} onChange={links.change} />
      {links.error ? <Alert color="red">{links.error}</Alert> : null}
      {tools.length ? (
        <Stack gap="xs">
          <Title order={5}>In this cluster</Title>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            {tools.map((app) => (
              <AppOffer
                key={app.id}
                app={app}
                onDeployed={(result) => {
                  if (result.url && app.linkKey) links.change(LINK_FIELD[app.linkKey], result.url);
                  discovery.refresh();
                }}
              />
            ))}
          </SimpleGrid>
        </Stack>
      ) : null}
      <DiscoveryNote discovery={discovery} />
    </StepFrame>
  );
}

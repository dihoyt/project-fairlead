import { Alert, Anchor, Code, Loader, Paper, Stack, Table, Text, Title } from "@mantine/core";
import { useApi } from "../../ui/api";
import { PageHeader } from "../PageHeader";
import type { SettingView } from "@contracts/auth";
import { CheckRulesEditor } from "./CheckRulesEditor";
import { EDITED_ELSEWHERE, groupTitle, isSignInGroup } from "./groups";
import { LinksSettingEditor } from "./LinksSettingEditor";
import { ResetSection } from "./ResetSection";
import { SettingField } from "./SettingField";

export function SettingsPage() {
  const overview = useApi("GET /api/admin/overview");
  const data = overview.data;
  const header = <PageHeader title="Settings" description={data ? `Version ${data.version}` : undefined} />;
  if (!data) {
    return (
      <>
        {header}
        {overview.error ? <Alert color="red">{overview.error}</Alert> : <Loader size="sm" />}
      </>
    );
  }

  const groups = [...new Set(data.settings.map((s) => s.group))].filter((g) => !isSignInGroup(g));

  return (
    <>
      {header}
      <Stack gap="lg" maw={860}>
        {groups.map((group) => (
          <Paper withBorder p="lg" key={group}>
            <Stack gap="md">
              <Title order={4}>{groupTitle(group)}</Title>
              {data.settings
                .filter((s) => s.group === group)
                .map((s) => {
                  const elsewhere = EDITED_ELSEWHERE[s.key];
                  if (!elsewhere) {
                    return <Editor key={s.key} setting={s} settings={data.settings} onSaved={overview.reload} />;
                  }
                  return (
                    <Text key={s.key} size="sm" data-edited-elsewhere={s.key}>
                      {s.label}: set on the <Anchor href={elsewhere.href}>{elsewhere.page}</Anchor> page.
                    </Text>
                  );
                })}
            </Stack>
          </Paper>
        ))}
        <ResetSection onDone={overview.reload} />
        <Paper withBorder p="lg">
          <Stack gap="xs">
            <Title order={4}>Set by the environment</Title>
            <Text size="xs" c="dimmed">
              These decide whether this page can be reached and trusted, so they can only be changed where the app is
              deployed.
            </Text>
            {!data.secretKeyConfigured ? (
              <Alert color="yellow" variant="light">
                SECRETS_KEY is not set: secrets entered here cannot be stored.
              </Alert>
            ) : null}
            <Table fz="xs" verticalSpacing={4}>
              <Table.Tbody>
                {data.environment.map((entry) => (
                  <Table.Tr key={entry.name}>
                    <Table.Td>
                      <Code>{entry.name}</Code>
                    </Table.Td>
                    <Table.Td>
                      {entry.set ? (
                        entry.value
                      ) : (
                        <Text span c="dimmed" size="xs">
                          not set
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td c="dimmed">{entry.help}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Stack>
        </Paper>
      </Stack>
    </>
  );
}

// Settings whose stored value is JSON get a form of their own instead of a text box.
function Editor({
  setting,
  settings,
  onSaved,
}: {
  setting: SettingView;
  settings: SettingView[];
  onSaved: () => void;
}) {
  if (setting.key === "health.rules") return <CheckRulesEditor setting={setting} onSaved={onSaved} />;
  if (setting.key === "health.links") {
    return <LinksSettingEditor setting={setting} settings={settings} onSaved={onSaved} />;
  }
  return <SettingField setting={setting} onSaved={onSaved} />;
}

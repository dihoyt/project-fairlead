import { Alert, Code, Loader, Paper, Stack, Table, Text, Title } from "@mantine/core";
import { useApi } from "../../ui/api";
import { PageHeader } from "../PageHeader";
import { isSignInGroup } from "./groups";
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
              <Title order={4}>{group}</Title>
              {data.settings
                .filter((s) => s.group === group)
                .map((s) => (
                  <SettingField key={s.key} setting={s} onSaved={overview.reload} />
                ))}
            </Stack>
          </Paper>
        ))}
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

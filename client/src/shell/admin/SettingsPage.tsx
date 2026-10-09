import { useState, type ReactNode } from "react";
import {
  Alert,
  Anchor,
  Code,
  Group,
  Loader,
  NavLink,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useApi } from "../../ui/api";
import { PageHeader } from "../PageHeader";
import type { AdminOverview, SettingView } from "@contracts/auth";
import { CheckRulesEditor } from "./CheckRulesEditor";
import { EDITED_ELSEWHERE, groupTitle, isSignInGroup, SECTIONS, sectionOf, type SettingsSection } from "./groups";
import { LinksSettingEditor } from "./LinksSettingEditor";
import { ResetSection } from "./ResetSection";
import { SettingField } from "./SettingField";

export function SettingsPage() {
  const overview = useApi("GET /api/admin/overview");
  const [filter, setFilter] = useState("");
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

  const needle = filter.trim().toLowerCase();
  const matches = (s: SettingView) =>
    !needle || [s.label, s.key, s.help, groupTitle(s.group)].some((t) => t.toLowerCase().includes(needle));
  const shown = data.settings.filter((s) => !isSignInGroup(s.group) && matches(s));
  const groups = [...new Set(shown.map((s) => s.group))];
  const environment = data.environment.filter(
    (e) => !needle || [e.name, e.help].some((t) => t.toLowerCase().includes(needle))
  );
  const signInMatches = !needle || "sign-in sign in password oidc sessions authenticator".includes(needle);

  const body = (section: SettingsSection): ReactNode[] => {
    const parts: ReactNode[] = groups
      .filter((g) => sectionOf(g) === section)
      .map((group) => (
        <Paper withBorder p="lg" key={group}>
          <Stack gap="md">
            <Title order={4}>{groupTitle(group)}</Title>
            {shown
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
      ));
    if (section === "sign-in" && signInMatches) {
      parts.push(
        <Paper withBorder p="lg" key="sign-in">
          <Text size="sm">
            Passwords, OIDC, authenticators and sessions are set on the <Anchor href="#/admin/sign-in">Sign-in</Anchor>{" "}
            page.
          </Text>
        </Paper>
      );
    }
    if (section === "advanced") {
      if (!needle || "reset defaults".includes(needle)) {
        parts.push(<ResetSection key="reset" onDone={overview.reload} />);
      }
      if (environment.length > 0 || !needle) {
        parts.push(
          <Environment key="environment" entries={environment} secretKeyConfigured={data.secretKeyConfigured} />
        );
      }
    }
    return parts;
  };

  const sections = SECTIONS.map((s) => ({ ...s, parts: body(s.id) })).filter((s) => s.parts.length > 0);

  return (
    <>
      {header}
      <Group align="flex-start" gap="xl" wrap="nowrap">
        <Stack gap={2} w={180} visibleFrom="md" pos="sticky" top={16} data-settings-index>
          {sections.map((s) => (
            <NavLink
              key={s.id}
              label={s.title}
              onClick={() => document.getElementById(`settings-${s.id}`)?.scrollIntoView({ behavior: "smooth" })}
            />
          ))}
        </Stack>
        <Stack gap="lg" maw={860} style={{ flex: 1, minWidth: 0 }}>
          <TextInput
            aria-label="Filter settings"
            placeholder="Filter settings"
            leftSection={<IconSearch size={14} />}
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
          />
          {sections.length === 0 ? (
            <Text size="sm" c="dimmed">
              No setting matches &quot;{filter.trim()}&quot;.
            </Text>
          ) : null}
          {sections.map((s) => (
            <Stack gap="md" key={s.id} id={`settings-${s.id}`} data-settings-section={s.id}>
              <Title order={3}>{s.title}</Title>
              {s.parts}
            </Stack>
          ))}
        </Stack>
      </Group>
    </>
  );
}

function Environment({
  entries,
  secretKeyConfigured,
}: {
  entries: AdminOverview["environment"];
  secretKeyConfigured: boolean;
}) {
  return (
    <Paper withBorder p="lg">
      <Stack gap="xs">
        <Title order={4}>Set by the environment</Title>
        <Text size="xs" c="dimmed">
          These decide whether this page can be reached and trusted, so they can only be changed where the app is
          deployed.
        </Text>
        {!secretKeyConfigured ? (
          <Alert color="yellow" variant="light">
            SECRETS_KEY is not set: secrets entered here cannot be stored.
          </Alert>
        ) : null}
        <Table fz="xs" verticalSpacing={4}>
          <Table.Tbody>
            {entries.map((entry) => (
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

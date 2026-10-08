import { Button, Group, Stack, Text } from "@mantine/core";
import type { SettingView } from "@contracts/auth";
import { LinksFields, useLinksForm } from "../../modules/onboarding/LinksForm";
import { SettingNotes } from "./SettingField";

// The setup wizard's Links form: it writes health.links and the deep-link
// settings of the modules that use the same tools.
export function LinksSettingEditor({
  setting,
  settings,
  onSaved,
}: {
  setting: SettingView;
  settings: SettingView[];
  onSaved: () => void;
}) {
  const links = useLinksForm(settings, onSaved);
  const locked = setting.locked === true;
  return (
    <Stack gap="xs" data-setting={setting.key}>
      <Text size="sm" fw={500}>
        {setting.label}
      </Text>
      <Text size="xs" c="dimmed">
        The tools you already use. Category pages, checks and workloads link straight into them; leave any you
        don&apos;t run empty.
      </Text>
      <LinksFields form={links.form} onChange={links.change} disabled={locked} />
      <SettingNotes setting={setting} />
      {links.error ? (
        <Text size="xs" c="red">
          {links.error}
        </Text>
      ) : null}
      {links.saved ? (
        <Text size="xs" c="green">
          Saved.
        </Text>
      ) : null}
      {links.dirty && !locked ? (
        <Group gap="xs">
          <Button size="xs" loading={links.busy} onClick={() => void links.submit()}>
            Save
          </Button>
        </Group>
      ) : null}
    </Stack>
  );
}

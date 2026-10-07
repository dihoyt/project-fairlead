import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Group,
  NumberInput,
  Select,
  Stack,
  Switch,
  TagsInput,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import type { SettingValue, SettingView } from "@contracts/auth";
import { apiRequest } from "../../ui/api";

const SOURCE: Record<SettingView["source"], { label: string; color: string }> = {
  ui: { label: "Set here", color: "cyan" },
  env: { label: "From environment", color: "grape" },
  default: { label: "Default", color: "gray" },
};

const same = (a: SettingValue, b: SettingValue) => JSON.stringify(a) === JSON.stringify(b);

// Edited locally and saved explicitly: a list saved on every keystroke
// would send half-typed CIDRs to a server that rejects them, and could trip
// a lockout guard mid-edit.
export function SettingField({ setting, onSaved }: { setting: SettingView; onSaved: () => void }) {
  const [draft, setDraft] = useState<SettingValue>(setting.value);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(setting.value), [setting.value]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const params = { key: setting.key };
  const save = () => run(() => apiRequest("PUT /api/admin/settings/:key", { params, body: { value: draft } }));
  const reset = () => run(() => apiRequest("DELETE /api/admin/settings/:key", { params }));
  const dirty = !same(draft, setting.value);
  const source = SOURCE[setting.source];

  let input;
  switch (setting.type) {
    case "boolean":
      input = (
        <Switch checked={draft === true} onChange={(e) => setDraft(e.currentTarget.checked)} label={setting.label} />
      );
      break;
    case "number":
      input = (
        <NumberInput
          label={setting.label}
          value={typeof draft === "number" ? draft : Number(draft)}
          onChange={(value) => setDraft(Number(value))}
          maw={200}
        />
      );
      break;
    case "list":
    case "cidrs":
      input = (
        <TagsInput
          label={setting.label}
          value={Array.isArray(draft) ? (draft as string[]) : []}
          onChange={setDraft}
          placeholder={setting.type === "cidrs" ? "e.g. 192.168.1.0/24, Enter to add" : "Enter to add"}
          splitChars={[",", " "]}
          clearable
        />
      );
      break;
    case "enum":
      input = (
        <Select
          label={setting.label}
          data={[...(setting.options ?? [])]}
          value={String(draft)}
          onChange={(value) => value !== null && setDraft(value)}
          allowDeselect={false}
          maw={320}
        />
      );
      break;
    case "json":
      input = <JsonField label={setting.label} value={draft} onChange={setDraft} />;
      break;
    default:
      input = (
        <TextInput
          label={setting.label}
          type={setting.type === "url" ? "url" : "text"}
          value={String(draft)}
          onChange={(e) => setDraft(e.currentTarget.value)}
        />
      );
  }

  return (
    <Stack gap={4} data-setting={setting.key}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div style={{ flex: 1 }}>{input}</div>
        <Badge size="xs" variant="light" color={source.color} mt={setting.type === "boolean" ? 2 : 26}>
          {source.label}
        </Badge>
      </Group>
      <Text size="xs" c="dimmed">
        {setting.help}
        {setting.env ? (
          <>
            {" "}
            Environment variable: <code>{setting.env}</code>.
          </>
        ) : null}
      </Text>
      {setting.envError ? (
        <Text size="xs" c="orange">
          The environment's value was ignored: {setting.envError}
        </Text>
      ) : null}
      {error ? (
        <Text size="xs" c="red">
          {error}
        </Text>
      ) : null}
      {dirty || setting.source === "ui" ? (
        <Group gap="xs">
          {dirty ? (
            <>
              <Button size="xs" onClick={() => void save()} loading={busy}>
                Save
              </Button>
              <Button size="xs" variant="subtle" onClick={() => setDraft(setting.value)} disabled={busy}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="xs" variant="subtle" color="gray" onClick={() => void reset()} loading={busy}>
              Reset to {setting.envValue !== undefined ? "environment value" : "default"}
            </Button>
          )}
        </Group>
      ) : null}
    </Stack>
  );
}

// Edited as text and handed up only once it parses, so Save always sends
// JSON; the server checks the shape.
function JsonField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: SettingValue;
  onChange: (v: SettingValue) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setText(JSON.stringify(value, null, 2)), [value]);
  return (
    <Textarea
      label={label}
      value={text}
      autosize
      minRows={3}
      ff="monospace"
      error={invalid ? "Not valid JSON yet." : undefined}
      onChange={(event) => {
        const next = event.currentTarget.value;
        setText(next);
        try {
          onChange(JSON.parse(next) as SettingValue);
          setInvalid(false);
        } catch {
          setInvalid(true);
        }
      }}
    />
  );
}

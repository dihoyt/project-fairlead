import { useEffect, useState } from "react";
import { Alert, Button, Group, Loader, Stack, Text, TextInput } from "@mantine/core";
import type { AdminOverview } from "@contracts/auth";
import { useApi } from "../../../ui";
import { putSetting } from "../settings";
import { useAction } from "../shared";

// What the field starts with: the configured URL, else the address this
// page was opened on, which is what the server would guess too.
export function suggestedPublicUrl(overview: Pick<AdminOverview, "publicUrl">, here = window.location.origin): string {
  return overview.publicUrl.source === "request" ? here : overview.publicUrl.value;
}

export function PublicUrlField() {
  const overview = useApi("GET /api/admin/overview");
  const data = overview.data;
  const [value, setValue] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = useAction();

  useEffect(() => {
    if (!data || loaded) return;
    setValue(suggestedPublicUrl(data));
    setLoaded(true);
  }, [data, loaded]);

  if (!data) return overview.error ? <Alert color="red">{overview.error}</Alert> : <Loader size="sm" />;

  const help =
    "The address people use to reach this install. Sign-in redirects, including the OIDC redirect URI, use it.";

  if (data.publicUrl.source === "env") {
    return (
      <Stack gap={4}>
        <TextInput label="Public URL" value={data.publicUrl.value} readOnly />
        <Text size="xs" c="dimmed">
          {help} Set by the environment (PUBLIC_ORIGIN); change it where the app is deployed.
        </Text>
      </Stack>
    );
  }

  async function submit() {
    const ok = await save.run(() => putSetting("site.publicUrl", value.trim()));
    if (ok) {
      setSaved(true);
      overview.reload();
    }
  }

  return (
    <Stack gap={4}>
      <Group align="flex-end" gap="xs">
        <TextInput
          label="Public URL"
          placeholder="https://console.example.com"
          value={value}
          onChange={(e) => {
            setValue(e.currentTarget.value);
            setSaved(false);
          }}
          style={{ flex: 1 }}
          maw={480}
        />
        <Button variant="default" loading={save.busy} disabled={!value.trim()} onClick={() => void submit()}>
          Save
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        {help}
        {data.publicUrl.source === "request" && !saved ? " Filled in from this page's address; check it and save." : ""}
      </Text>
      {saved ? (
        <Text size="xs" c="green">
          Saved.
        </Text>
      ) : null}
      {save.error ? <Alert color="red">{save.error}</Alert> : null}
    </Stack>
  );
}

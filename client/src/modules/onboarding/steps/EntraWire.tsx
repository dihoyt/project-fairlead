import { useState } from "react";
import { Link } from "react-router";
import {
  Alert,
  Anchor,
  Button,
  Code,
  Group,
  List,
  Loader,
  MultiSelect,
  Paper,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import type { EntraGroup, EntraSignInView } from "@contracts/connectors";
import { apiRequest, useApi } from "../../../ui";
import { useAction } from "../shared";

const day = (iso?: string) => (iso ? iso.slice(0, 10) : "");

// The http public URL warning is the one the Access step fixes.
const isHttpWarning = (warning?: string) => warning !== undefined && /refuses http/.test(warning);

function GroupPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const [search, setSearch] = useState("");
  const [known, setKnown] = useState<Record<string, string>>({});
  const groups = useApi("GET /api/connector-entra/groups", { query: search.trim() ? { search: search.trim() } : {} });
  const found: EntraGroup[] = groups.data ?? [];

  // Without Group.Read.All the tenant can't be listed; ids are typed instead.
  if (groups.error) {
    return (
      <TextInput
        label="Admin groups"
        description={`Group object ids, comma separated. Listing groups failed: ${groups.error}`}
        placeholder="00000000-0000-0000-0000-000000000000"
        value={value.join(", ")}
        onChange={(e) =>
          onChange(
            e.currentTarget.value
              .split(",")
              .map((g) => g.trim())
              .filter(Boolean)
          )
        }
      />
    );
  }

  const names = { ...known, ...Object.fromEntries(found.map((g) => [g.id, g.displayName])) };
  const data = [...new Set([...value, ...found.map((g) => g.id)])].map((id) => ({ value: id, label: names[id] ?? id }));
  return (
    <MultiSelect
      label="Admin groups"
      description="Members of these Entra security groups are admins here. Leave empty to keep admins as they are."
      placeholder={value.length ? undefined : "Search groups"}
      searchable
      searchValue={search}
      onSearchChange={setSearch}
      filter={({ options }) => options}
      data={data}
      value={value}
      onChange={(ids) => {
        setKnown(names);
        onChange(ids);
      }}
      rightSection={groups.loading ? <Loader size={14} /> : undefined}
      nothingFoundMessage={groups.loading ? "Searching…" : "No security group starts with that"}
    />
  );
}

export function EntraWire({
  onWired,
  onOpenAccess,
}: {
  // With the result of the sign-in discovery test run right after.
  onWired: (view: EntraSignInView, test: { ok: boolean; issuer?: string; error?: string }) => void;
  onOpenAccess?: () => void;
}) {
  const view = useApi("GET /api/connector-entra/view");
  const [open, setOpen] = useState(false);
  const [admins, setAdmins] = useState<string[]>([]);
  const wire = useAction();

  const v = view.data;
  if (view.loading && !v) return <Loader size="sm" />;
  if (view.error) return <Alert color="red">{view.error}</Alert>;
  if (!v) return null;

  if (!v.connectorId) {
    return (
      <Group gap="xs" data-entra-none>
        <Text size="sm">Using Microsoft Entra ID?</Text>
        <Button component={Link} to="/admin/connectors" size="xs" variant="light">
          Add the Entra connector
        </Button>
        <Text size="xs" c="dimmed">
          With it, sign-in is set up from here instead of the Entra portal.
        </Text>
      </Group>
    );
  }

  async function run() {
    const done = await wire.run(async () => {
      const wired = await apiRequest("POST /api/connector-entra/signin", {
        body: admins.length ? { adminGroups: admins } : {},
      });
      return { wired, test: await apiRequest("POST /api/admin/oidc/test") };
    });
    if (done) {
      setOpen(false);
      view.reload();
      onWired(done.wired, done.test);
    }
  }

  const warning = v.warning ? (
    <Alert color="yellow" data-entra-warning>
      <Stack gap={6}>
        <Text size="sm">{v.warning}</Text>
        {isHttpWarning(v.warning) && onOpenAccess ? (
          <Group>
            <Button size="xs" variant="light" onClick={onOpenAccess}>
              Set up https on the Access step
            </Button>
          </Group>
        ) : null}
      </Stack>
    </Alert>
  ) : null;

  const blocked = v.warning !== undefined && (isHttpWarning(v.warning) || !v.redirectUri);

  if (v.wired && v.app && !open) {
    return (
      <Stack gap="xs" data-entra-wired>
        <Alert color={v.app.state === "in-sync" ? "green" : "yellow"} title="Signing in through Microsoft Entra ID">
          <Stack gap={4}>
            <Text size="sm">
              App registration <Code>{v.app.displayName}</Code> (client ID <Code>{v.app.appId}</Code>)
              {v.app.secretExpiresAt
                ? `; its secret is valid until ${day(v.app.secretExpiresAt)} and is replaced 30 days before.`
                : "."}
            </Text>
            {v.app.state === "in-sync" ? null : (
              <Text size="sm">
                It has changed in Entra ({v.app.state}); the next sync puts it back, or run setup again.
              </Text>
            )}
            <Anchor href={new URL("auth/oidc/start?link=1", document.baseURI).href} size="sm">
              Test sign-in
            </Anchor>
          </Stack>
        </Alert>
        {warning}
        <Group>
          <Button size="xs" variant="subtle" onClick={() => setOpen(true)}>
            Change admin groups or run again
          </Button>
        </Group>
      </Stack>
    );
  }

  if (!open) {
    return (
      <Stack gap="xs" data-entra-ready>
        {warning}
        <Group gap="xs">
          <Button size="xs" disabled={blocked} onClick={() => setOpen(true)}>
            Set up sign-in with Entra
          </Button>
          <Text size="xs" c="dimmed">
            Creates the app registration in your tenant and fills in the fields below.
          </Text>
        </Group>
      </Stack>
    );
  }

  return (
    <Paper withBorder p="sm" data-entra-wire>
      <Stack gap="xs">
        <Text size="sm" fw={500}>
          This {v.app ? "updates" : "creates"}, in tenant <Code>{v.tenantId}</Code>:
        </Text>
        <List size="sm" spacing={2}>
          <List.Item>
            an app registration
            {v.app ? (
              <>
                {" "}
                (<Code>{v.app.appId}</Code>)
              </>
            ) : null}{" "}
            with redirect URI <Code>{v.redirectUri}</Code> and the groups claim
          </List.Item>
          <List.Item>a new client secret, valid for a year and replaced 30 days before it expires</List.Item>
          <List.Item>and turns on sign-in here with that client</List.Item>
        </List>
        {v.consentUrl ? (
          <Text size="xs" c="dimmed">
            If it fails for lack of permission, a tenant admin grants it on the{" "}
            <Anchor href={v.consentUrl} target="_blank" rel="noreferrer" size="xs">
              admin consent page
            </Anchor>
            .
          </Text>
        ) : null}
        {warning}
        <GroupPicker value={admins} onChange={setAdmins} />
        {wire.error ? <Alert color="red">{wire.error}</Alert> : null}
        <Group gap="xs">
          <Button size="xs" loading={wire.busy} disabled={blocked} onClick={() => void run()}>
            {v.app ? "Update in Entra" : "Create in Entra"}
          </Button>
          <Button size="xs" variant="subtle" color="gray" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

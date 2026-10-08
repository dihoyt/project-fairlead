import { useState } from "react";
import { Alert, Anchor, Button, Group, PasswordInput, Stack, Text, TextInput } from "@mantine/core";
import type { ConnectorKindView, ConnectorTestResult, ConnectorView } from "@contracts/connectors";
import { CheckList } from "../../ui/CheckList";
import { apiRequest } from "../../ui/api";

interface Props {
  kind: ConnectorKindView;
  // Editing: secret fields left empty keep the stored value.
  existing?: ConnectorView;
  onSaved: (view: ConnectorView) => void;
  onCancel?: () => void;
}

export function ConnectorForm({ kind, existing, onSaved, onCancel }: Props) {
  const [name, setName] = useState(existing?.name ?? kind.label);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(kind.fields.map((f) => [f.key, f.type === "secret" ? "" : (existing?.config[f.key] ?? "")]))
  );
  const [result, setResult] = useState<ConnectorTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);

  const missing = kind.fields.some(
    (f) => f.required && !values[f.key]?.trim() && !(f.type === "secret" && existing?.secrets[f.key])
  );

  async function run(what: "test" | "save") {
    setBusy(what);
    setError(null);
    try {
      if (what === "test") {
        setResult(
          await apiRequest("POST /api/connectors/test", {
            body: { kind: kind.kind, values, ...(existing ? { id: existing.id } : {}) },
          })
        );
      } else {
        onSaved(
          existing
            ? await apiRequest("PUT /api/connectors/:id", { params: { id: existing.id }, body: { name, values } })
            : await apiRequest("POST /api/connectors", { body: { kind: kind.kind, name, values } })
        );
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Stack gap="sm" data-connector-form={kind.kind}>
      <Text size="sm">{kind.description}</Text>
      {kind.docsUrl ? (
        <Anchor href={kind.docsUrl} target="_blank" rel="noreferrer" size="sm">
          Create the credential in {kind.label}
        </Anchor>
      ) : null}
      <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} required />
      {kind.fields.map((field) => {
        const common = {
          label: field.label,
          description: field.help,
          placeholder:
            field.type === "secret" && existing?.secrets[field.key] ? "Stored; leave empty to keep" : field.placeholder,
          required: field.required && !(field.type === "secret" && existing?.secrets[field.key]),
          value: values[field.key] ?? "",
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
            const value = e.currentTarget.value;
            setValues((prev) => ({ ...prev, [field.key]: value }));
          },
        };
        return field.type === "secret" ? (
          <PasswordInput key={field.key} autoComplete="off" {...common} />
        ) : (
          <TextInput key={field.key} {...common} />
        );
      })}
      {result ? (
        <Stack gap={4}>
          <Text size="sm" fw={500} c={result.ok ? "teal" : "red"}>
            {result.ok ? "Everything checks out" : "Not working yet"}
          </Text>
          <CheckList results={result.checks} />
        </Stack>
      ) : null}
      {error ? <Alert color="red">{error}</Alert> : null}
      <Group>
        <Button variant="default" onClick={() => void run("test")} loading={busy === "test"} disabled={missing}>
          Test
        </Button>
        <Button onClick={() => void run("save")} loading={busy === "save"} disabled={missing || !name.trim()}>
          {existing ? "Save" : "Add"}
        </Button>
        {onCancel ? (
          <Button variant="subtle" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </Group>
    </Stack>
  );
}
